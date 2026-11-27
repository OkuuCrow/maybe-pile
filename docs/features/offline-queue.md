# Offline add queue (§16.6, core)

When a search fails because you are offline or the source is unavailable, **Add now, look up details later**
creates the item from what you typed (title, type, optional year) and queues the lookup. Nothing is lost.

The queue retries shortly after start and every 10 minutes while online (and on **Retry now**),
sequentially through the source's rate limiter, with exponential backoff (up to 6 attempts). Found matches
wait for your review; applying one fills **only empty fields** (user-entered values are never overwritten).
Cancelling stops the lookup; the item stays. A “N waiting for details” badge appears on Home and cards.
Optional “Offline queue finished” notification (off). Data: `lookup_queue` (local; not exported).
