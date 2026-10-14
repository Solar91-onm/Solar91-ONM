from __future__ import annotations

import itertools
import struct
import zlib
from uuid import uuid4

import gevent
from locust import HttpUser, between, task

from safety import LoadTestConfig, load_config, validate_active_target


def _png_1x1() -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00\x00"))
        + chunk(b"IEND", b"")
    )


_user_ordinals = itertools.count()


class PortalUser(HttpUser):
    wait_time = between(1, 4)

    def on_start(self) -> None:
        self.config: LoadTestConfig = load_config()
        validate_active_target(self.client.base_url, self.config)
        self.client.headers.update(
            {
                "Authorization": f"Bearer {self.config.bearer_token}",
                "Accept": "application/json",
            }
        )
        self.synthetic_issue_id: str | None = None
        self.synthetic_ticket_no: str | None = None
        self.workflow_complete = False
        self.workflow_user = next(_user_ordinals) % 10 == 0
        if self.workflow_user:
            self.workflow_complete = True
            self._workflow_once()

    def _dashboard(self) -> None:
        with self.client.get("/api/bootstrap", name="/api/bootstrap [dashboard]", catch_response=True) as response:
            if response.status_code != 200:
                response.failure(f"Dashboard bootstrap returned HTTP {response.status_code}")

    def _issues(self, status: str | None = None) -> list[dict] | None:
        params = {
            "plant_id": self.config.plant_id,
            "limit": 50,
            "offset": 0,
            "q": self.config.issue_prefix,
        }
        if status:
            params["status"] = status
        with self.client.get(
            "/api/issues",
            params=params,
            name="/api/issues [synthetic list/filter]",
            catch_response=True,
        ) as response:
            if response.status_code != 200:
                response.failure(f"Synthetic issue list returned HTTP {response.status_code}")
                return None
            else:
                rows = response.json()
                if not isinstance(rows, list) or any(
                    not str(row.get("ticket_no", "")).startswith(self.config.issue_prefix)
                    for row in rows
                ):
                    response.failure("Issue query returned a record outside this synthetic run")
                    return None
                return rows

    def _plant_search(self) -> None:
        with self.client.get(
            "/api/plants",
            params={"q": self.config.plant_site_code, "limit": 10, "offset": 0},
            name="/api/plants [synthetic site search]",
            catch_response=True,
        ) as response:
            if response.status_code != 200:
                response.failure(f"Plant search returned HTTP {response.status_code}")
            else:
                rows = response.json()
                if not any(row.get("site_code") == self.config.plant_site_code for row in rows):
                    response.failure("Plant search did not find the designated synthetic site")

    def _issue_detail(self) -> None:
        if not self.synthetic_issue_id:
            rows = self._issues()
            if not rows:
                return
            self.synthetic_issue_id = str(rows[0]["id"])
        issue_path = f"/api/issues/{self.synthetic_issue_id}"
        for path, label in (
            (f"{issue_path}/activity", "activity"),
            (f"{issue_path}/steps", "steps"),
        ):
            with self.client.get(
                path,
                name=f"/api/issues/{{issue_id}}/{label}",
                catch_response=True,
            ) as response:
                if response.status_code != 200:
                    response.failure(f"Synthetic issue {label} returned HTTP {response.status_code}")

    def _integrity_failure(self, name: str, message: str) -> None:
        with self.client.get(
            "/health",
            name=f"INTEGRITY FAILURE: {name}",
            catch_response=True,
        ) as response:
            response.failure(message)

    def _verify_synthetic_issue(self, expected_status: str, maker: str, impact: str) -> bool:
        with self.client.get(
            "/api/issues",
            params={
                "plant_id": self.config.plant_id,
                "q": self.synthetic_ticket_no,
                "limit": 5,
                "offset": 0,
            },
            name="/api/issues [workflow integrity check]",
            catch_response=True,
        ) as response:
            if response.status_code != 200:
                response.failure(f"Issue integrity query returned HTTP {response.status_code}")
                return False
            rows = response.json()
            exact = [row for row in rows if row.get("ticket_no") == self.synthetic_ticket_no]
            if len(exact) != 1:
                response.failure(
                    f"Expected one record for synthetic ticket, found {len(exact)}"
                )
                return False
            row = exact[0]
            if (
                row.get("status") != expected_status
                or row.get("maker") != maker
                or row.get("impact") != impact
                or row.get("assigned_to") != self.config.assignee_id
            ):
                response.failure("Issue state differs from expected workflow state")
                return False
            return True

    def _patch_field(self, issue_path: str, payload: dict[str, str]) -> None:
        with self.client.patch(
            issue_path,
            json=payload,
            name="/api/issues/{issue_id} [concurrent update]",
            catch_response=True,
        ) as response:
            if response.status_code != 200:
                response.failure(f"Concurrent issue update returned HTTP {response.status_code}")

    def _workflow_once(self) -> None:
        self._dashboard()
        self._issues()
        self._plant_search()

        ticket_no = self.config.issue_prefix + uuid4().hex[:16]
        payload = {
            "ticket_no": ticket_no,
            "plant_id": self.config.plant_id,
            "vertical": "Inverter",
            "description": f"SYNTHETIC LOAD TEST {self.config.run_id} - {ticket_no}",
            "severity": "Low",
            "maker": "Load test pending",
            "impact": "Synthetic load-test record",
        }
        with self.client.post(
            "/api/issues",
            json=payload,
            name="/api/issues [create synthetic]",
            catch_response=True,
        ) as response:
            if response.status_code != 201:
                response.failure(f"Synthetic issue creation returned HTTP {response.status_code}")
                return
            issue = response.json()
            self.synthetic_issue_id = str(issue["id"])
            self.synthetic_ticket_no = ticket_no

        with self.client.post(
            "/api/issues",
            json=payload,
            name="/api/issues [duplicate rejection]",
            catch_response=True,
        ) as response:
            if response.status_code != 409:
                response.failure(
                    f"Duplicate synthetic submission should return 409, got {response.status_code}"
                )
                return
            response.success()

        issue_path = f"/api/issues/{self.synthetic_issue_id}"
        with self.client.post(
            f"{issue_path}/assign",
            json={"assigned_to": self.config.assignee_id, "note": f"Load test {self.config.run_id}"},
            name="/api/issues/{issue_id}/assign",
            catch_response=True,
        ) as response:
            if response.status_code != 200:
                response.failure(f"Synthetic issue assignment returned HTTP {response.status_code}")
                return

        maker = f"LT-MAKER-{self.config.run_id}"
        impact = f"LT-IMPACT-{self.config.run_id}"
        first = gevent.spawn(
            self._patch_field,
            issue_path,
            {"maker": maker, "change_reason": "Synthetic concurrent load-test edit"},
        )
        second = gevent.spawn(
            self._patch_field,
            issue_path,
            {"impact": impact, "change_reason": "Synthetic concurrent load-test edit"},
        )
        gevent.joinall((first, second), timeout=30)
        if any(greenlet.dead is False for greenlet in (first, second)):
            self._integrity_failure("concurrent-update-timeout", "Concurrent issue updates exceeded 30 seconds")
            return
        if any(greenlet.exception for greenlet in (first, second)):
            self._integrity_failure("concurrent-update-exception", "A concurrent issue update raised an exception")
            return
        if not self._verify_synthetic_issue("Assigned", maker, impact):
            return

        self._issue_detail()
        if self.config.upload_evidence:
            self._upload_and_check_private_evidence()

        with self.client.post(
            f"{issue_path}/close",
            json={"direct": True, "note": f"Synthetic load-test close {self.config.run_id}"},
            name="/api/issues/{issue_id}/close [synthetic]",
            catch_response=True,
        ) as response:
            if response.status_code != 200 or response.json().get("status") != "Closed":
                response.failure(f"Synthetic issue close returned HTTP {response.status_code}")
                return

        with self.client.post(
            f"{issue_path}/close",
            json={"direct": True, "note": f"Synthetic duplicate close {self.config.run_id}"},
            name="/api/issues/{issue_id}/close [duplicate rejection]",
            catch_response=True,
        ) as response:
            if response.status_code != 409:
                response.failure(
                    f"Repeated close should return 409, got {response.status_code}"
                )
                return
            response.success()

        self._verify_synthetic_issue("Closed", maker, impact)

    def _upload_and_check_private_evidence(self) -> None:
        issue_path = f"/api/issues/{self.synthetic_issue_id}"
        with self.client.post(
            f"{issue_path}/evidence",
            files={"files": (f"synthetic-{self.config.run_id}.png", _png_1x1(), "image/png")},
            name="/api/issues/{issue_id}/evidence [synthetic upload]",
            catch_response=True,
        ) as response:
            if response.status_code != 200:
                response.failure(f"Synthetic evidence upload returned HTTP {response.status_code}")
                return
            evidence = response.json()
            if not evidence or not evidence[0].get("id"):
                response.failure("Evidence upload response did not include an evidence ID")
                return
            evidence_id = evidence[0]["id"]

        evidence_path = f"{issue_path}/evidence/{evidence_id}"
        with self.client.get(
            evidence_path,
            name="/api/issues/{issue_id}/evidence/{evidence_id} [private read]",
            catch_response=True,
        ) as response:
            if response.status_code != 200:
                response.failure(f"Authenticated evidence read returned HTTP {response.status_code}")

        with self.client.get(
            evidence_path,
            headers={"Authorization": ""},
            name="/api/issues/{issue_id}/evidence/{evidence_id} [anonymous denial]",
            catch_response=True,
        ) as response:
            if response.status_code != 401:
                response.failure(f"Anonymous evidence access should return 401, got {response.status_code}")
            else:
                response.success()
    @task(6)
    def dashboard(self) -> None:
        self._dashboard()

    @task(5)
    def issue_list(self) -> None:
        self._issues()

    @task(3)
    def issue_filter(self) -> None:
        self._issues(status="Assigned")

    @task(3)
    def plant_search(self) -> None:
        self._plant_search()

    @task(2)
    def issue_detail(self) -> None:
        self._issue_detail()
