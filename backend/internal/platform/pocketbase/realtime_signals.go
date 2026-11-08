package pocketbase

import (
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

const (
	// realtimeSignalsCollection is the nudge queue realtime delivers through. See
	// migration 1768400000 and markdowns/DONE_REALTIME_TRANSPORT_DESIGN.md.
	realtimeSignalsCollection = "realtime_signals"

	// realtimeSignalAudienceAll marks a signal every signed-in member may see.
	realtimeSignalAudienceAll = "*"

	// realtimeSignalRetention is how long a signal is worth keeping.
	//
	// A signal is not news, it is a nudge: the client that receives one re-reads
	// the real thing through /api/aerun within a poll interval. Once a signal is
	// older than a few poll cycles, every subscriber to it has already re-read
	// (or missed, and will get it from the next poll anyway). An hour is far more
	// than any reasonable gap and costs one row per write in the meantime.
	realtimeSignalRetention = time.Hour

	// realtimeSignalPruneEvery bounds the prune. Doing it on every write would
	// issue a DELETE next to every INSERT; every 64th write keeps the cost off
	// the hot path while still reclaiming rows within minutes of them expiring.
	realtimeSignalPruneEvery = 64
)

// realtimeSignalPruneCounter counts writes toward the next prune. Plain int
// rather than atomic: publishSignal is called from request handlers, and a
// slightly imprecise count only makes the prune land at a slightly different
// moment.
var realtimeSignalPruneCounter int

// Signal topic names. Closed by convention, and short on purpose — a typo costs a
// missed refresh that polling covers, whereas a long opaque token would cost a
// reader's understanding.
const (
	realtimeSignalNotificationNew = "notification.new"
	realtimeSignalDMPost          = "dm.post"
	// realtimeSignalDMRead is the read-receipt nudge: somebody caught up on
	// their inbox. Addressed to the READER, counters-only — it never renders
	// content and never means "a message arrived". Separate from dm.post
	// because the payload cannot tell them apart (both carry a conversation
	// id), so the topic is the only honest divider; every DM resource re-reads
	// on any signal, and only topic-stats filters DM topics out (forum.js).
	realtimeSignalDMRead    = "dm.read"
	realtimeSignalTopicPost = "topic.post"
	// realtimeSignalPresenceUpdate announces that the online composition
	// changed (join, TTL eviction, rename, admin delete/ban). The signal
	// carries no member data — clients re-read /api/aerun/status, where
	// authorization and the presence windows live, exactly like every
	// other topic on this bus.
	realtimeSignalPresenceUpdate = "presence.update"
)

// presenceSignalDebounce collapses a burst of presence transitions into one
// nudge. Presence is chatty by nature (every login, rename and eviction is
// a transition, and several can land within seconds of each other), and a
// client only needs to re-read the status snapshot once per burst — the
// snapshot always reflects the latest composition, so intermediate nudges
// carry no additional information.
const presenceSignalDebounce = 2 * time.Second

var (
	presenceSignalMu      sync.Mutex
	presenceSignalTimer   *time.Timer
	presenceSignalPending bool
)

// publishPresenceSignal announces "the online composition changed" to every
// signed-in member, debounced. Callers invoke it after mutating the online
// set (heartbeat join, TTL eviction, nickname change, admin delete/ban);
// the first call arms a 2-second timer and further calls inside the window
// only mark the signal pending, so a burst costs exactly one row.
func publishPresenceSignal(app core.App) {
	if app == nil {
		return
	}
	presenceSignalMu.Lock()
	if presenceSignalPending {
		presenceSignalMu.Unlock()
		return
	}
	presenceSignalPending = true
	// The timer captures the app it was armed with. A test app is torn down
	// (its DB closed) long before a 2-second timer fires, and publishSignal
	// on a dead app panics inside PocketBase. The guard below makes a dead
	// app a no-op: a signal is a latency optimisation, so losing one to a
	// teardown is always safe.
	presenceSignalTimer = time.AfterFunc(presenceSignalDebounce, func() {
		presenceSignalMu.Lock()
		presenceSignalPending = false
		presenceSignalTimer = nil
		presenceSignalMu.Unlock()
		if app == nil {
			return
		}
		defer func() {
			// A closed DB panics rather than erroring; swallow it — the
			// signal is best-effort by design and polling covers the gap.
			_ = recover()
		}()
		publishSignal(app, realtimeSignalPresenceUpdate, "", realtimeSignalAudienceAll)
	})
	presenceSignalMu.Unlock()
}

// publishTopicSignal announces that a topic changed, to exactly the audience the
// topic is already visible to.
//
// THE AUDIENCE IS DECIDED AGAINST THE GUEST BASELINE, not against the author.
// That is the careful part, and it is why this is a function rather than a
// one-liner at the call site:
//
//   - In a category a GUEST may read, the topic is already public to every
//     signed-out visitor, so broadcasting its existence to every member reveals
//     nothing that the forum page itself does not show.
//   - In a category a guest may NOT read, a public signal would announce
//     "something happened" to the entire forum about a thread nobody else is
//     allowed to know exists. No content rides along — the signal is an id —
//     but the EXISTENCE of activity is itself information, and a private
//     category is the one place this design must not leak even that.
//
// A narrower audience than "everyone who could read it" is not attempted. The
// signal carries no content, so the only thing a member who cannot read the
// topic learns is that a topic id moved — and the client re-reads through
// /api/aerun, which returns them nothing.
//
// A RESTRICTED topic therefore simply gets no public signal, and its readers
// keep polling. That is the correct degradation: slower, never wrong.
func publishTopicSignal(app core.App, topic *core.Record) {
	categoryID := topic.GetString("category_id")
	if categoryID == "" {
		// A topic with no category has no visibility rule to check against, and
		// guessing "public" for it would be exactly the fail-open this exists to
		// avoid.
		return
	}
	allowed, err := canViewCategory(app, guestAccess(), categoryID)
	if err != nil || !allowed {
		return
	}
	publishSignal(app, realtimeSignalTopicPost, topic.Id, realtimeSignalAudienceAll)
}

// publishSignal tells one member — or every member — that something changed, so a
// client can re-read it through the command layer.
//
// WHAT IT DELIBERATELY DOES NOT TAKE is the content. There is no title, no body,
// no author, no counter parameter, and adding one is the leak this whole design
// exists to prevent. A subscriber learns an id and nothing else, and it has to
// go back through /api/aerun — which owns authorization — to learn anything
// more. That is why the function signature has nowhere to put content.
//
// WHY A FAILED SIGNAL IS NOT AN ERROR. The notification, DM or post is already
// committed by the time this runs; the signal is only a latency optimisation on
// top of it. A signal that fails to write costs the subscriber one poll interval,
// while a signal that fails the write would cost them their post. So the error is
// logged and swallowed, and the caller is told nothing.
//
// It takes the APP it should write through rather than reaching for a global,
// because most callers are inside a transaction they are about to commit, and a
// signal written outside that transaction would be visible before the thing it
// announces.
func publishSignal(app core.App, topic, entityID, audienceID string) {
	if app == nil {
		return
	}
	audienceID = strings.TrimSpace(audienceID)
	if audienceID == "" {
		// A signal with no audience has no reader, and writing it would only
		// grow the table. The one legitimate caller of this is a write that has
		// no recipient — which is exactly the case where there is nothing to
		// announce.
		return
	}

	col, err := app.FindCollectionByNameOrId(realtimeSignalsCollection)
	if err != nil {
		app.Logger().Warn("realtime signal collection unavailable; polling will cover it",
			"error", err, "topic", topic)
		return
	}

	record := core.NewRecord(col)
	record.Set("topic", topic)
	record.Set("entity_id", entityID)
	record.Set("audience_id", audienceID)
	record.Set("at", types.NowDateTime())

	if err := app.Save(record); err != nil {
		app.Logger().Warn("failed to publish realtime signal; polling will cover it",
			"error", err, "topic", topic)
		return
	}

	realtimeSignalPruneCounter++
	if realtimeSignalPruneCounter >= realtimeSignalPruneEvery {
		realtimeSignalPruneCounter = 0
		pruneRealtimeSignals(app)
	}
}

// pruneRealtimeSignals deletes signals past their retention window.
//
// Best-effort by design, like the write: an un-pruned table is slower, never
// wrong, and the rows expire on their own the moment nothing reads them. A prune
// that failed loudly would turn housekeeping into a user-visible failure.
func pruneRealtimeSignals(app core.App) {
	cutoff := types.NowDateTime().Add(-realtimeSignalRetention)
	err := app.DB().
		Delete(realtimeSignalsCollection, dbx.NewExp("at < {:cutoff}", dbx.Params{"cutoff": cutoff.Time()}))
	if err != nil {
		app.Logger().Warn("failed to prune realtime signals", "error", err)
	}
}
