alter table public.intraday_breakout_signals
  add column if not exists prior_intraday_low double precision,
  add column if not exists previous_day_low double precision;

alter table public.intraday_breakout_signals
  drop constraint if exists intraday_breakout_signals_signal_type_check;

alter table public.intraday_breakout_signals
  add constraint intraday_breakout_signals_signal_type_check
  check (signal_type in (
    'FIVE_MIN_BREAKOUT', 'FIFTEEN_MIN_BREAKOUT', 'PREVIOUS_DAY_HIGH_BREAK',
    'FIVE_MIN_BREAKDOWN', 'FIFTEEN_MIN_BREAKDOWN', 'PREVIOUS_DAY_LOW_BREAK'
  ));

alter table public.intraday_breakout_signals
  drop constraint if exists intraday_signal_timeframe_matches_type;

alter table public.intraday_breakout_signals
  add constraint intraday_signal_timeframe_matches_type
  check (
    (signal_type in ('FIVE_MIN_BREAKOUT', 'FIVE_MIN_BREAKDOWN') and timeframe_minutes = 5)
    or (signal_type in ('FIFTEEN_MIN_BREAKOUT', 'FIFTEEN_MIN_BREAKDOWN') and timeframe_minutes = 15)
    or (signal_type in ('PREVIOUS_DAY_HIGH_BREAK', 'PREVIOUS_DAY_LOW_BREAK') and timeframe_minutes = 0)
  );
