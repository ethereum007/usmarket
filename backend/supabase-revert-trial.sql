-- ============================================================================
-- Alpha Radar - Disable 14-day Trial
-- Run this in: Supabase Dashboard → SQL Editor → New Query → paste → Run
-- ============================================================================

-- New signups get a free plan, not a premium trial.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.subscriptions (user_id, plan, status)
  VALUES (NEW.id, 'free', 'active');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- End unpaid trials that were granted during the trial window.
-- Paid Razorpay subscriptions and coupon-based active premium rows are not touched.
UPDATE public.subscriptions
   SET plan = 'free',
       status = 'active',
       current_period_start = NULL,
       current_period_end = NULL,
       updated_at = NOW()
 WHERE status = 'trialing'
   AND razorpay_subscription_id IS NULL;
