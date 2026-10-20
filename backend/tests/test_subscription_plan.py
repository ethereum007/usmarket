from __future__ import annotations

import unittest

from app.routes.subscription import MONTHLY_PRICE_PAISE, PLAN_DURATION_DAYS


class MonthlySubscriptionPlanTest(unittest.TestCase):
    def test_premium_membership_is_priced_and_limited_to_one_month(self) -> None:
        self.assertEqual(MONTHLY_PRICE_PAISE, 99_900)
        self.assertEqual(PLAN_DURATION_DAYS, 30)


if __name__ == "__main__":
    unittest.main()
