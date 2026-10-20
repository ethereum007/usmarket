# Alpha Radar — Latest NSE Updates

Route: `/latest-updates`

The page reads the existing NSE cron publisher's `announcement_signals` table directly through Supabase public read access. It does not make requests to earningscanvas.in. The existing Earnings Canvas GitHub workflows continue to collect and publish the data.

The default view opens the latest available announcement day. Date boundaries use IST. Search and category filters apply to cards; the chart covers all categories for the selected date and search, so selecting a slice preserves the whole-day comparison. Maximum 1,000 records per date, with an explicit notice if reached. Announcements without a valid event timestamp are excluded.

Server reads are cached for 60 seconds, bounded by 12-second timeouts. Visible browser tabs refresh every five minutes. An unavailable feed displays an error instead of generated data. Public access uses the existing anon credential, never a service-role key. `NSE_FEED_SUPABASE_URL` and `NSE_FEED_PUBLISHABLE_KEY` can override the public defaults independently of Alpha Radar's authentication database.

## Image

Created with the built-in image-generation tool. Saved as `nse-updates.png` in the deliverables and `public/images/nse-updates.png` in the application.

Prompt: Create a refined editorial illustration for Alpha Radar's NSE corporate announcements dashboard. Wide landscape banner, 1536x1024. An elegant miniature Indian business district with modern office towers, an industrial factory, shipping containers and subtle paper filing sheets integrated in the scene, conveying company announcements and business activity. Deep midnight navy background with restrained emerald green and warm ivory highlights, sophisticated tactile 3D paper and matte architectural model style, soft studio lighting, crisp detailed forms. Main scene concentrated on the right two thirds; left third dark quiet negative space for website headline overlay. No lettering, numbers, logos, stock charts or pie charts. This is conceptual editorial artwork, not a depiction of an actual exchange building.
