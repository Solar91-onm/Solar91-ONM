from datetime import date
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from app.pmplan import recurrence as pm


class FakeEngine:
    def __init__(self, *, months=(), configured=True, lock=True, fail_month=None, dialect="postgresql"):
        self.dialect = SimpleNamespace(name=dialect)
        self.months = months
        self.configured = configured
        self.lock = lock
        self.fail_month = fail_month
        self.calls = []
        self.commits = 0
        self.rollbacks = 0

    @contextmanager
    def begin(self):
        try:
            yield self
        except Exception:
            self.rollbacks += 1
            raise
        else:
            self.commits += 1

    def execute(self, statement, params=None):
        self.calls.append((str(statement), params))

    def scalar(self, statement, params=None):
        self.execute(statement, params)
        sql = str(statement)
        if "to_regprocedure" in sql:
            return self.configured
        if "pg_try_advisory" in sql:
            return self.lock
        if "SELECT solar91_pm.ensure_month" in sql:
            if params['month'] == self.fail_month:
                raise RuntimeError('validation failed')
            return 159
        raise AssertionError(sql)

    def scalars(self, statement, params=None):
        self.execute(statement, params)
        return self.months


def test_rolling_window_starts_in_december_and_rolls_over_year():
    assert pm.rolling_window(date(2026, 11, 25)) == (date(2026, 12, 1), date(2027, 11, 1))
    assert pm.rolling_window(date(2027, 1, 31)) == (date(2027, 1, 1), date(2027, 12, 1))
    assert pm.rolling_window(date(2028, 2, 29)) == (date(2028, 2, 1), date(2029, 1, 1))


def test_only_missing_months_generated_with_bounded_batch_and_shared_lock():
    missing = tuple(date(2027, i, 1) for i in range(1, 5))
    engine = FakeEngine(months=missing)
    result = pm.generate_missing_months(engine, today=date(2027, 1, 20))
    assert result.months == missing[:3] and result.inserted == 477 and result.more
    assert engine.commits == 1
    lock = next(params for sql, params in engine.calls if 'pg_try_advisory' in sql)
    assert lock['key'] == 91391020261201
    params = next(params for sql, params in engine.calls if 'generate_series' in sql)
    assert params == {'start': date(2026, 12, 1), 'horizon': date(2027, 12, 1),
                      'current': date(2027, 1, 1), 'limit': 4}
    assert [p['month'] for s, p in engine.calls if 'SELECT solar91_pm.ensure_month' in s] == list(missing[:3])
    assert not any('UPDATE ' in s or 'DELETE ' in s for s, _ in engine.calls)


@pytest.mark.parametrize('kwargs, expected', [({'configured': False}, 'not_configured'),
                                             ({'lock': False}, 'busy'),
                                             ({'dialect': 'sqlite'}, 'unsupported'),
                                             ({}, 'ok')])
def test_no_writes_when_unconfigured_busy_unsupported_or_up_to_date(kwargs, expected):
    engine = FakeEngine(**kwargs)
    result = pm.generate_missing_months(engine)
    assert result.state == expected and result.inserted == 0 and not result.months
    assert not any('SELECT solar91_pm.ensure_month' in s for s, _ in engine.calls)


def test_validation_failure_rolls_back_full_batch():
    months = (date(2026, 12, 1), date(2027, 1, 1))
    engine = FakeEngine(months=months, fail_month=months[1])
    with pytest.raises(RuntimeError, match='validation failed'):
        pm.generate_missing_months(engine)
    assert engine.commits == 0 and engine.rollbacks == 1


def test_on_demand_hint_is_bounded_by_start_and_horizon(monkeypatch):
    seen = []
    monkeypatch.setattr(pm, '_active_signal', SimpleNamespace(request=lambda: seen.append(True)))
    monkeypatch.setattr(pm, 'business_today', lambda: date(2027, 1, 1))
    pm.request_schedule_check(date(2026, 11, 1))
    pm.request_schedule_check(date(2028, 1, 1))
    assert not seen
    pm.request_schedule_check(date(2026, 12, 1))
    pm.request_schedule_check(date(2027, 12, 1))
    assert seen == [True, True]
