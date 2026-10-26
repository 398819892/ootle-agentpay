import random

from agentpay.models import StealthOut
from agentpay.payout import jitter_fee, plan_batch
from agentpay.privacy import assess


def test_plan_batch_splits_large_batches():
    payouts = [StealthOut(f"addr{i}", 10) for i in range(9)]
    plans = plan_batch(payouts, max_outputs_per_tx=3, rng=random.Random(0))
    assert sum(len(p.outputs) for p in plans) == 9
    assert all(len(p.outputs) <= 3 for p in plans)
    assert len(plans) >= 3


def test_plan_batch_never_puts_everyone_in_one_tx_when_avoidable():
    payouts = [StealthOut(f"addr{i}", 10) for i in range(4)]
    plans = plan_batch(payouts, max_outputs_per_tx=4, rng=random.Random(1))
    assert len(plans) >= 2


def test_plan_batch_single_payout_is_one_tx():
    plans = plan_batch([StealthOut("addr0", 10)], rng=random.Random(2))
    assert len(plans) == 1 and len(plans[0].outputs) == 1


def test_plan_batch_delays_sorted_and_bounded():
    payouts = [StealthOut(f"a{i}", 1) for i in range(6)]
    plans = plan_batch(payouts, max_outputs_per_tx=2, max_delay_s=100, rng=random.Random(3))
    delays = [p.delay_s for p in plans]
    assert delays == sorted(delays)
    assert all(0 <= d <= 100 for d in delays)


def test_jitter_fee_within_bounds():
    r = random.Random(4)
    for _ in range(50):
        f = jitter_fee(1000, spread=0.2, rng=r)
        assert 800 <= f <= 1200


def test_privacy_assess_flags_badge_variant_high():
    report = assess(coin_variant="badge")
    assert report.worst() == "high"
    assert any("enumerable" in l.what for l in report.leaks)


def test_privacy_assess_no_badge_is_lower_risk_but_not_clean():
    report = assess(coin_variant="no_badge", fee_reserve_funded_publicly=False)
    assert report.worst() != "high" or all("badge" not in l.what for l in report.leaks)
    # floor-level fee leak is always present, by design
    assert any(l.severity == "floor" for l in report.leaks)


def test_privacy_assess_batch_size_flag():
    report = assess(outputs_in_tx=5)
    assert any("batch" in l.what for l in report.leaks)
