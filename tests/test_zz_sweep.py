import pytest

from app.main import app
from tests.conftest import login_user


@pytest.mark.parametrize(
    "role",
    ["O&M Head", "Site Engineer", "Assignee", "Technician"],
)
def test_get_sweep(client, db, role):
    login_user(
        client,
        db,
        role=role,
        email=f"sweep-{role[:3].lower()}@example.com",
    )

    bad = []

    for route in app.routes:
        path = getattr(route, "path", "")

        if (
            "GET" not in (getattr(route, "methods", None) or [])
            or not path.startswith("/api")
            or "{" in path
        ):
            continue

        response = client.get(path)

        # SQLite does not install the permanent PostgreSQL
        # recurrence schema.
        # Verify the intentional fail-closed contract,
        # not a blanket 503 exemption.
        if (
            path == "/api/pm-plan/schedules"
            and db.get_bind().dialect.name == "sqlite"
        ):
            if role in {"O&M Head", "Assignee"}:
                expected = (
                    503,
                    {
                        "detail": (
                            "Permanent PM recurrence SQL is not installed"
                        )
                    },
                )
            else:
                expected = (
                    403,
                    {
                        "detail": (
                            "Only an O&M Head or Assignee may manage "
                            "recurring PM schedules"
                        )
                    },
                )

            assert response.status_code == expected[0], (
                path,
                response.status_code,
                response.text,
            )

            assert response.json() == expected[1], (
                path,
                response.text,
            )

            continue

        if response.status_code >= 500:
            bad.append(
                (
                    path,
                    response.status_code,
                    response.text[:200],
                )
            )

    assert not bad, bad