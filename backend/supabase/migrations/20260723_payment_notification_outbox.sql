-- Apply only to the Alpha Radar Supabase project (xphrxbmvavrbqgmldbak).
-- This outbox stores operational delivery state only; no payment card data or
-- customer profile fields are retained here.

create table if not exists public.payment_notification_outbox (
    id uuid primary key default gen_random_uuid(),
    razorpay_payment_id text not null unique,
    razorpay_order_id text,
    user_id uuid references auth.users(id) on delete set null,
    status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
    attempts integer not null default 0 check (attempts >= 0),
    resend_email_id text,
    recipient_count integer not null default 0 check (recipient_count >= 0),
    last_error text,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    sent_at timestamptz
);

create index if not exists payment_notification_outbox_status_created_at_idx
    on public.payment_notification_outbox (status, created_at desc);

alter table public.payment_notification_outbox enable row level security;
revoke all on table public.payment_notification_outbox from anon, authenticated;
grant all on table public.payment_notification_outbox to service_role;
