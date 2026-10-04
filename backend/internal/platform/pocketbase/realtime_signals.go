package pocketbase

import (
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

const (
	// realtimeSignalsCollection is the nudge queue realtime delivers through. See
	// migration 1768400000 and markdowns/REALTIME_TRANSPORT_DESIGN.md.
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
	realtimeSignalTopicPost       = "topic.post"
)

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
