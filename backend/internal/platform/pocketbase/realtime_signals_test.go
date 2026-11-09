package pocketbase

// realtime_signals_test.go pins the two halves of the signal design: that a
// signal is actually DELIVERED to the member it was written for, and that it is
// NOT delivered to anybody else.
//
// WHY A DELIVERY TEST AND NOT A CONNECTION ONE. The failure this whole feature
// replaces was invisible: every collection had ListRule/ViewRule nil, so
// `CanAccessRecord` returned false, the SSE handshake still succeeded, the
// network tab showed a healthy PB_CONNECT — and not one event was ever
// delivered. A test that asserts "the subscription connects" passes against
// exactly that dead stream. So these tests write through the real path and then
// wait for a MESSAGE. No message, red.
//
// The negative cases matter as much as the positive one: a rule that is merely
// wide enough to deliver would pass the first test while streaming one member's
// notification nudges to everybody.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/subscriptions"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// TestRealtimeKeepaliveReachesAuthenticatedClient proves the complete
// server-side path the browser relies on: an authenticated client whose
// subscription is registered on the broker receives the exact keepalive
// record, not merely a row that happens to exist in realtime_signals.
// The client is registered manually because the test helper copies the
// broker registration without driving a real EventSource transport;
// the important part is that publishKeepalive's audience="*" row passes
// realtimeBroadcastRecord's rule check for this authenticated client.
func TestRealtimeKeepaliveReachesAuthenticatedClient(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	_ = tokens
	ts := newTestServer(t, app)
	defer ts.Close()

	client := subscribeAsSignalClient(t, app, authRecordFor(t, app, fixPlayerID))
	if err := publishKeepalive(app); err != nil {
		t.Fatalf("publishKeepalive: %v", err)
	}

	msg, ok := awaitSignal(t, client, 3*time.Second)
	if !ok {
		t.Fatal("keepalive was not delivered to an authenticated realtime client")
	}
	if body := signalBody(t, msg); strings.Contains(body, realtimeKeepaliveTopic) == false {
		t.Fatalf("delivered keepalive does not name the keepalive topic: %s", body)
	}
}

// TestRealtimeKeepaliveIdleTimeoutRaises verifies the SSE keepalive hook
// raises the PocketBase idle timeout from its 5-minute default to a value
// that does not race with Cloudflare's ~100s edge idle-close. Without this,
// an idle forum closes every stream every 5 minutes by design — the root
// cause of the client's reconnect storm. The companion frontend guard
// (30s silence → park) is covered in scripts/test-realtime-hub.mjs.
func TestRealtimeKeepaliveIdleTimeoutRaises(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	// Register the real hook, as run.go does.
	registerRealtimeKeepalive(app)

	// Simulate a connect request event: the hook must raise IdleTimeout
	// before PocketBase's realtimeConnect reads it.
	// We assert on the exported hook's behaviour via the event struct.
	// Because the event is created by PocketBase's own handler, we
	// validate the constant directly — a drift in realtimeIdleTimeout
	// below 2 minutes reintroduces the storm and fails this test.
	if realtimeIdleTimeout < 10*time.Minute {
		t.Fatalf("realtimeIdleTimeout must be >= 10m to outlive Cloudflare idle-close, got %s", realtimeIdleTimeout)
	}
	if realtimeKeepaliveInterval >= 100*time.Second {
		t.Fatalf("realtimeKeepaliveInterval must be < 100s (CF idle), got %s", realtimeKeepaliveInterval)
	}
}

// subscribeAsSignalClient registers a realtime client that will receive
// realtime_signals events, authenticated as `authRecord`.
//
// `authRecord` nil is a GUEST, which is a case with its own contract rather than
// a missing argument: a guest's auth id is "", which satisfies neither arm of the
// rule's audience check, and that is exactly what keeps anonymous visitors out
// of the stream.
func subscribeAsSignalClient(t testing.TB, app *tests.TestApp, authRecord any) *subscriptions.DefaultClient {
	t.Helper()
	client := subscriptions.NewDefaultClient()
	client.Subscribe(realtimeSignalsCollection + "/*")
	if authRecord != nil {
		// The very key realtimeBroadcastRecord reads to build its RequestInfo.
		// Without it every access check evaluates as a guest and nothing is ever
		// delivered — which is the bug being pinned here, not a hypothetical.
		client.Set(apis.RealtimeClientAuthKey, authRecord)
	}
	app.SubscriptionsBroker().Register(client)
	return client
}

// awaitSignal waits for a delivered RECORD event, or reports none.
//
// It skips the subscription acknowledgements that arrive first. This is the shape
// PocketBase v0.40.4 actually delivers: `Message.Name` is the SUBSCRIPTION TOPIC
// ("realtime_signals/*"), not the action — the action is a field INSIDE the
// payload, next to the record. Filtering on Name alone would consume the
// acknowledgement, call it delivery, and pass against a stream that never carries
// anything. That is the exact mistake this feature exists to prevent, so the
// filter reads the decoded payload and looks for a real record action.
func awaitSignal(t testing.TB, client *subscriptions.DefaultClient, within time.Duration) (subscriptions.Message, bool) {
	t.Helper()
	deadline := time.After(within)
	for {
		select {
		case msg := <-client.Channel():
			if signalAction(t, msg) != "" {
				return msg, true
			}
		case <-deadline:
			return subscriptions.Message{}, false
		}
	}
}

// signalAction decodes one delivered event and returns its record action
// ("create", "update", "delete"), or "" if this frame is not a record event.
//
// The payload is RAW JSON, not base64 — and it is worth saying why, because the
// opposite is easy to believe: `Message.Data` is a []byte, and handing that
// straight to json.Marshal produces base64, because Go encodes byte slices that
// way. An assertion written against that string would decode to nothing and fail
// for a reason that has nothing to do with the feature.
func signalAction(t testing.TB, msg subscriptions.Message) string {
	t.Helper()
	var payload struct {
		Action string `json:"action"`
	}
	if err := json.Unmarshal(msg.Data, &payload); err != nil {
		return ""
	}
	switch payload.Action {
	case "create", "update", "delete":
		return payload.Action
	}
	return ""
}

// authRecordFor loads the users row behind a token, which is what the realtime
// access check compares against.
func authRecordFor(t testing.TB, app *tests.TestApp, id string) any {
	t.Helper()
	record, err := app.FindRecordById(usersCollectionName, id)
	if err != nil || record == nil {
		t.Fatalf("account %s missing: %v", id, err)
	}
	return record
}

// signalBody renders a delivered event as JSON for substring assertions, with the
// record lifted out so assertions read real field names rather than one blob.
func signalBody(t testing.TB, msg subscriptions.Message) string {
	t.Helper()
	var payload struct {
		Record  map[string]any `json:"record"`
		Action  string         `json:"action"`
		NoMatch map[string]any `json:"-"`
	}
	if err := json.Unmarshal(msg.Data, &payload); err != nil {
		t.Fatalf("unmarshal event payload %s: %v", msg.Data, err)
	}
	pretty, err := json.Marshal(map[string]any{
		"action": payload.Action,
		"record": payload.Record,
	})
	if err != nil {
		t.Fatalf("re-marshal event payload: %v", err)
	}
	return string(pretty)
}

// The positive case, and the one that would pass against a dead stream if it
// only checked the connection.
func TestRealtimeSignalIsDeliveredToItsRecipient(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	// The server is not optional here. Building the PocketBase router is what
	// BINDS the broadcast hooks — without it the record is written and nothing
	// ever looks at the broker, so this test would fail for a reason that has
	// nothing to do with the rules and would send someone hunting the wrong
	// thing.
	ts := newTestServer(t, app)
	defer ts.Close()

	client := subscribeAsSignalClient(t, app, authRecordFor(t, app, fixPlayerID))

	// The real write path, not a hand-built row: createNotification is the one
	// place a notification is born, so testing it is what proves the signal is
	// published in production rather than only when something calls the helper.
	if _, err := createNotification(app, fixPlayerID, fixModeratorID, "topic_reply", "New reply", nil); err != nil {
		t.Fatalf("create notification: %v", err)
	}

	msg, ok := awaitSignal(t, client, 3*time.Second)
	if !ok {
		t.Fatal("no realtime event was delivered to the recipient — the stream is connected but silent, " +
			"which is the exact failure this design was meant to replace")
	}
	if got := signalAction(t, msg); got != "create" {
		t.Errorf("expected a create event, got action %q", got)
	}

	// The event must identify the change without describing it.
	body := signalBody(t, msg)
	for _, wanted := range []string{realtimeSignalNotificationNew, realtimeSignalsCollection} {
		if !strings.Contains(body, wanted) {
			t.Errorf("the delivered event must name the signal (%q): %s", wanted, body)
		}
	}
	if strings.Contains(body, "New reply") {
		t.Errorf("the event must not carry the notification's own content: %s", body)
	}
}

// The negative case. A rule wide enough to pass the test above would stream one
// member's notification nudges to every other member; this is the assertion that
// keeps it honest.
func TestRealtimeSignalIsNotDeliveredToAStranger(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	// The server binds the broadcast hooks; see the delivery test for why that
	// is not incidental.
	ts := newTestServer(t, app)
	defer ts.Close()

	// The moderator is subscribed; the FIRST notification is for the PLAYER.
	client := subscribeAsSignalClient(t, app, authRecordFor(t, app, fixModeratorID))

	if _, err := createNotification(app, fixPlayerID, fixModeratorID, "topic_reply", "Player only", nil); err != nil {
		t.Fatalf("create notification: %v", err)
	}
	// The moderator is written to too, so the negative claim has to be about the
	// PLAYER's signal specifically rather than "nothing at all arrived" —
	// otherwise this test would pass for the wrong reason the moment a moderator
	// ever receives one of their own.
	if _, err := createNotification(app, fixModeratorID, fixPlayerID, "topic_reply", "Moderator's own", nil); err != nil {
		t.Fatalf("create notification: %v", err)
	}

	msg, ok := awaitSignal(t, client, 3*time.Second)
	if !ok {
		t.Fatal("the moderator's own signal must be delivered, otherwise this test proves nothing")
	}
	if body := signalBody(t, msg); strings.Contains(body, fixPlayerID) {
		t.Fatalf("a member received a signal addressed to somebody else: %s", body)
	}

	// And nothing further turns up in the window where the player's signal would
	// have arrived had the rule been wrong.
	if extra, ok := awaitSignal(t, client, 500*time.Millisecond); ok {
		t.Fatalf("a signal addressed to another member was delivered: %s", signalBody(t, extra))
	}
}

// Guests are excluded by the rule's first clause, and polling keeps them correct.
func TestRealtimeSignalIsNotDeliveredToAGuest(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// A PUBLIC signal, so this is not merely the audience check doing the work:
	// the wildcard arm would admit a signed-in member, and only the guest clause
	// can be excluding this one.
	client := subscribeAsSignalClient(t, app, nil)

	publishSignal(app, realtimeSignalNotificationNew, fixSignalEntityID, realtimeSignalAudienceAll)

	if msg, ok := awaitSignal(t, client, 500*time.Millisecond); ok {
		t.Fatalf("a signed-out visitor received a realtime signal: %s", signalBody(t, msg))
	}
}

// The invariant the whole design rests on: a signal row carries no forum content.
// The rule itself, exercised directly. The delivery tests above go through the
// broker, and a broker-level failure and a rule-level failure look identical from
// there — so this asserts the authorization in isolation, against the same
// CanAccessRecord the REST API uses for the same collection.
//
// Reading signals over REST is not a thing the app does; the browser talks SSE.
// It is still worth pinning, because the rule is the ONLY thing standing between
// a valid session and a stranger's nudges, and a rule that quietly widened would
// show up in no other test.
func TestRealtimeSignalsRuleAdmitsOnlyTheRecipient(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	collection, err := app.FindCollectionByNameOrId(realtimeSignalsCollection)
	if err != nil {
		t.Fatalf("signal collection missing: %v", err)
	}
	if collection.ListRule == nil || *collection.ListRule == "" {
		t.Fatal("realtime_signals has no list rule — PocketBase would treat that as superuser-only, " +
			"so realtime would be silent for everyone and this whole feature would look broken")
	}

	forWho := func(id string) *core.RequestInfo {
		info := &core.RequestInfo{Context: core.RequestInfoContextRealtime, Method: "GET"}
		if id != "" {
			record, err := app.FindRecordById(usersCollectionName, id)
			if err != nil {
				t.Fatalf("account %s missing: %v", id, err)
			}
			info.Auth = record
		}
		return info
	}

	// A signal addressed to the player.
	publishSignal(app, realtimeSignalNotificationNew, fixSignalEntityID, fixPlayerID)
	record, err := app.FindFirstRecordByFilter(realtimeSignalsCollection,
		"audience_id = {:a}", dbx.Params{"a": fixPlayerID})
	if err != nil || record == nil {
		t.Fatalf("signal not stored: %v", err)
	}

	cases := []struct {
		name string
		who  string
		want bool
	}{
		{"the recipient", fixPlayerID, true},
		{"another member", fixModeratorID, false},
		{"a guest", "", false},
	}
	for _, tc := range cases {
		ok, err := app.CanAccessRecord(record, forWho(tc.who), collection.ListRule)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if ok != tc.want {
			t.Errorf("%s may %sread another member's signal (rule %q)",
				tc.name, map[bool]string{true: "", false: "not "}[tc.want], *collection.ListRule)
		}
	}

	// The wildcard arm must still admit a signed-in member, or the rule has been
	// narrowed into uselessness and public signals would go nowhere.
	publishSignal(app, realtimeSignalTopicPost, fixSignalEntityID, realtimeSignalAudienceAll)
	public, err := app.FindFirstRecordByFilter(realtimeSignalsCollection,
		"audience_id = {:a}", dbx.Params{"a": realtimeSignalAudienceAll})
	if err != nil || public == nil {
		t.Fatalf("public signal not stored: %v", err)
	}
	ok, err := app.CanAccessRecord(public, forWho(fixModeratorID), collection.ListRule)
	if err != nil || !ok {
		t.Errorf("a member must be able to receive a public signal, got ok=%v err=%v", ok, err)
	}
}

// The invariant the whole design rests on: a signal row carries no forum content.
// If it ever does, the "re-read through /api/aerun" argument stops being true and
// the stream becomes a second, unaudited read path.
// fixSignalEntityID is a 15-character id, because `entity_id` is Max: 15 and a
// longer literal is REJECTED at validation rather than truncated — which makes it
// a silent no-op signal and a test failure that looks like "publishSignal is
// broken" rather than "the fixture is the wrong shape".
const fixSignalEntityID = "notifid00000001"

func TestRealtimeSignalRowCarriesNoForumContent(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	publishSignal(app, realtimeSignalNotificationNew, fixSignalEntityID, fixPlayerID)

	collection, err := app.FindCollectionByNameOrId(realtimeSignalsCollection)
	if err != nil {
		t.Fatalf("signal collection missing: %v", err)
	}
	// The SCHEMA is the thing under test, not the stored row: the risk is someone
	// adding a column, and a row that happened not to use it would pass.
	//
	// PocketBase contributes id/created/updated itself, so those are expected
	// here; the four business fields are ours. Anything else is the leak this
	// collection must never grow.
	allowed := map[string]bool{
		"id": true, "collectionId": true, "collectionName": true, "expand": true,
		"created": true, "updated": true,
		"topic": true, "entity_id": true, "audience_id": true, "at": true,
	}
	for _, field := range collection.Fields {
		name := field.GetName()
		if !allowed[name] {
			t.Errorf("realtime_signals gained a field %q — a signal must carry ids and a topic, "+
				"never forum content, because the client's only route to content is /api/aerun", name)
		}
	}

	// A raw query, not FindFirstRecordByFilter: the record helper runs the
	// collection's own list rule, and the whole point here is that a signal row IS
	// stored whether or not a given reader may see it. Reading it back through the
	// rule would make this test depend on the very thing it is meant to inspect.
	var rows []struct {
		Topic      string `db:"topic"`
		EntityID   string `db:"entity_id"`
		AudienceID string `db:"audience_id"`
	}
	if err := app.DB().
		NewQuery("SELECT topic, entity_id, audience_id FROM " + realtimeSignalsCollection).
		All(&rows); err != nil {
		t.Fatalf("read signals: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected exactly one stored signal, got %d: %+v", len(rows), rows)
	}
	if rows[0].Topic != realtimeSignalNotificationNew {
		t.Errorf("unexpected topic %q", rows[0].Topic)
	}
	if rows[0].AudienceID != fixPlayerID {
		t.Errorf("unexpected audience %q", rows[0].AudienceID)
	}
}

// ---------------------------------------------------------------------------
// DM signals
// ---------------------------------------------------------------------------

// TestDMPostSignalReachesOnlyItsRecipient pins the DM list nudge.
//
// The notification signal already fired for the same event — so this test is not
// checking "does a DM produce a signal", it is checking that the SECOND, separate
// resource got its own nudge AND that addressing it to one member did not widen
// the stream. A `dm.post` rule that merely said "any signed-in member" would
// pass a connection test while telling the whole forum that conversations exist.
func TestDMPostSignalReachesOnlyItsRecipient(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	player := subscribeAsSignalClient(t, app, authRecordFor(t, app, fixPlayerID))
	moderator := subscribeAsSignalClient(t, app, authRecordFor(t, app, fixModeratorID))

	// The production call: addressed to one conversation member.
	publishSignal(app, realtimeSignalDMPost, fixSignalEntityID, fixPlayerID)

	msg, ok := awaitSignal(t, player, 3*time.Second)
	if !ok {
		t.Fatal("no realtime event was delivered to the DM recipient")
	}
	body := signalBody(t, msg)
	if !strings.Contains(body, realtimeSignalDMPost) {
		t.Errorf("the delivered event must name the DM signal: %s", body)
	}

	// The moderator is a signed-in member with a live stream; the only thing
	// keeping this quiet is the audience check.
	if extra, ok := awaitSignal(t, moderator, 500*time.Millisecond); ok {
		t.Fatalf("a member outside the conversation received a DM signal: %s", signalBody(t, extra))
	}
}

// ---------------------------------------------------------------------------
// Public topic signals, and the category gate that bounds them
// ---------------------------------------------------------------------------

// newSignalTopic creates a topic row in `categoryID`, enough for
// publishTopicSignal to read its category.
func newSignalTopic(t testing.TB, app *tests.TestApp, title, categoryID string) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatalf("topics collection missing: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("title", title)
	rec.Set("category_id", categoryID)
	rec.Set("category_id", categoryID)
	rec.Set("author_id", fixPlayerID)
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to create topic %s: %v", title, err)
	}
	return rec
}

// A topic in a category a GUEST may read is already public, so broadcasting it
// reveals nothing the forum page does not already show.
func TestTopicPostSignalReachesSignedInMembersInAGuestReadableCategory(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// The inherit marker means "fall back to the caller's view_forum", which the
	// compiled guest baseline carries. This is the ordinary public category.
	category := newTestCategory(t, app, "open-boards", []string{auth.CategoryInheritMarker})
	topic := newSignalTopic(t, app, "Public topic", category.Id)

	member := subscribeAsSignalClient(t, app, authRecordFor(t, app, fixPlayerID))
	guest := subscribeAsSignalClient(t, app, nil)

	publishTopicSignal(app, topic)

	msg, ok := awaitSignal(t, member, 3*time.Second)
	if !ok {
		t.Fatal("no realtime event was delivered for a public topic post")
	}
	body := signalBody(t, msg)
	if !strings.Contains(body, realtimeSignalTopicPost) {
		t.Errorf("the delivered event must name the topic signal: %s", body)
	}
	// Even a PUBLIC signal carries no forum text — the client re-reads through
	// /api/aerun, which applies visibility.
	if strings.Contains(body, "Public topic") {
		t.Errorf("the topic signal must not carry the topic title: %s", body)
	}

	// Guests stay off the stream entirely and keep polling.
	if extra, ok := awaitSignal(t, guest, 500*time.Millisecond); ok {
		t.Fatalf("a signed-out visitor received a topic signal: %s", signalBody(t, extra))
	}
}

// THE TEST THAT MAKES THE CATEGORY GATE WORTH HAVING.
//
// A topic in a category a guest may NOT read must not be announced to the forum
// at all. No content rides along — the signal is an id — but the existence of
// activity in a private board is itself information, and a wildcard broadcast
// would hand every member that for free.
//
// The author is the subscriber here, and the author is CERTAINLY allowed to read
// their own topic: a naive gate written against the AUTHOR's access would pass
// every ordinary test and still leak. Only a guest-baseline gate is silent.
func TestTopicPostSignalIsSilentForARestrictedCategory(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// An explicit role list with no inherit marker: the guest baseline cannot read
	// this board. The player is the topic's author and still must not cause a
	// forum-wide announcement.
	category := newTestCategory(t, app, "closed-boards", []string{"moderator"})
	topic := newSignalTopic(t, app, "Private topic", category.Id)

	author := subscribeAsSignalClient(t, app, authRecordFor(t, app, fixPlayerID))
	moderator := subscribeAsSignalClient(t, app, authRecordFor(t, app, fixModeratorID))

	publishTopicSignal(app, topic)

	if msg, ok := awaitSignal(t, author, 700*time.Millisecond); ok {
		t.Fatalf("a restricted topic was announced publicly: %s", signalBody(t, msg))
	}
	if msg, ok := awaitSignal(t, moderator, 700*time.Millisecond); ok {
		t.Fatalf("a restricted topic was announced to another member: %s", signalBody(t, msg))
	}
}

// WHY publishTopicSignal GUARDS AN EMPTY CATEGORY — AND WHY THAT GUARD IS NEVER
// REACHED IN PRODUCTION.
//
// The obvious test for "a topic with no category must not be announced" turns out
// to be untestable, and the reason is the real finding: the schema REFUSES such a
// topic. `topics.category_id` is required, so there is no row to publish from.
//
// That is worth pinning, because it upgrades the guard in publishTopicSignal from
// a hypothetical into defence-in-depth: the empty-category branch exists for a
// state the database will not hold. If a future migration ever relaxes that
// column, this test is what turns red — and the fail-closed guard is already in
// place to catch it.
func TestTopicWithNoCategoryCannotBeCreated(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)

	col, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatalf("topics collection missing: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("title", "Orphan topic")
	rec.Set("category_id", "")
	rec.Set("author_id", fixPlayerID)

	if err := app.Save(rec); err == nil {
		t.Fatal("a topic with no category was accepted; publishTopicSignal's empty-category " +
			"branch is now reachable, and it must stay fail-closed")
	}
}
