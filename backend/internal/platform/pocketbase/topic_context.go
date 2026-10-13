package pocketbase

// GET /api/aerun/topics/{id}/context — the topic page's ONE caller-scoped read
// (F2 of INPROGRESS_TOPIC_OPEN_READS_AND_DRAFT_SAFETY_PLAN).
//
// WHY THIS EXISTS. On open the topic page used to make three separate
// one-shot reads of caller-scoped state — the draft (GET /topics/{id}/draft),
// the Follow/Unfollow button (GET /topics/{id}/subscription) and the karma
// arrows (GET /me/votes?topic_id=). All three are read once on mount, none is
// read anywhere else on the page, and all three are keyed by (caller, topic).
// That is the same shape as GET /me/unread-counts, which README.md justifies
// as "one question — all four belong on one endpoint". Folding them into
// /context is what takes topic-open from 7 GETs to 4.
//
// REUSES, DOES NOT REIMPLEMENT: draftPayload (drafts.go) renders the draft,
// the topic_subscriptions lookup is the one getTopicSubscriptionStatusHandler
// does, and the reputation_votes lookup is the one listMyVotesHandler does.
// The three are direct reads, NOT runCommand: there is no write here and no
// idempotency claim (GET routes carry none), so a transaction would buy
// nothing and runCommand would refuse for want of a claim.
//
// NO RequirePermission: a read of a publicly visible topic, same as
// GET /topics/{id} and /stats. Visibility is enforced by canViewTopic — a
// topic in a category the caller may not see answers 404, byte-identical to a
// missing topic, so the existence of a hidden thread never leaks.
//
// Banned is the ONE caller-scoped branch that answers 403 before anything
// else (owner ruling 2026-10-11, §7.1): a banned member is supposed to be
// intercepted globally (Part 8), never served an empty context that reads as
// "you have no draft and no votes". The refusal is the same 403
// listMyVotesHandler gives; explaining the ban to the member is the client's
// GlobalModals job, not this endpoint's. It must precede canViewTopic, which
// would otherwise answer 404 (a banned account has already lost view_forum).
//
// GUEST CONTRACT IS A REQUIREMENT, NOT AN OPTION (owner-approved). The three
// separate calls failed differently for a signed-out visitor — draft 403,
// votes 401, subscription 200/false — and each failure was swallowed by its
// own catch. Collapsed into one endpoint a 403 would break the ENTIRE topic
// page, so a guest gets 200 with the empty shape: no draft, not subscribed,
// no votes. The facts are simply empty for a caller who has none.
//
// Field contract (pinned by TestTopicContext*): topic_id, draft, subscribed,
// votes, request_id — and nothing else.
import (
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// getTopicContextHandler answers GET /api/aerun/topics/{id}/context.
func getTopicContextHandler(e *core.RequestEvent) error {
	id := e.Request.PathValue("id")
	acc := AccessFrom(e)

	// Banned is refused BEFORE the visibility check and before any read: the
	// 403 is the global interception contract (Part 8), not a "no rows here"
	// answer. canViewTopic below would turn a banned caller into a 404.
	if acc.Status == auth.StatusBanned {
		return forbiddenError("banned accounts cannot read topic context")
	}

	// Hidden or missing topic is 404, byte-identical either way.
	allowed, topic, err := canViewTopic(e.App, acc, id)
	if err != nil || !allowed || topic == nil {
		return notFoundError("topic not found")
	}

	// Guest: the empty shape, still 200. The visibility check above already
	// refused a hidden thread; a visible one simply has no caller-scoped state
	// for a caller who is signed out.
	if e.Auth == nil || e.Auth.Collection().Name != usersCollectionName {
		return e.JSON(http.StatusOK, map[string]any{
			"topic_id":   topic.Id,
			"draft":      nil,
			"subscribed": false,
			"votes":      []map[string]any{},
			"request_id": requestIDFrom(e),
		})
	}
	userID := e.Auth.Id

	// The caller's draft in this topic, or null. Same lookup as getDraftHandler.
	var draft any
	if rec, _ := e.App.FindFirstRecordByFilter(
		postsCollectionName,
		"topic_id = {:topic} && author_id = {:author} && is_draft = true",
		dbx.Params{"topic": topic.Id, "author": userID},
	); rec != nil {
		draft = draftPayload(rec)
	}

	// Whether the caller Follows this topic. Same lookup as
	// getTopicSubscriptionStatusHandler.
	sub, subErr := e.App.FindFirstRecordByFilter(
		topicSubscriptionsCollectionName,
		"topic_id = {:topic} && user_id = {:user}",
		dbx.Params{"topic": topic.Id, "user": userID},
	)
	subscribed := subErr == nil && sub != nil

	// The caller's votes in this topic. Only the fields the page reads to
	// paint its arrows — the voter list itself comes from GET /posts/{id}/voters
	// when the eye button is clicked. Same query as listMyVotesHandler, scoped
	// to this one topic; the cap is a pathological-account guard, not a page
	// contract (a truncated answer would silently un-paint old arrows).
	var voteRows []*core.Record
	if err := e.App.RecordQuery(reputationVotesCollectionName).
		AndWhere(dbx.HashExp{"voter_id": userID}).
		AndWhere(dbx.HashExp{"topic_id": topic.Id}).
		OrderBy("created DESC", "id DESC").Limit(1000).All(&voteRows); err != nil {
		return internalError("failed to read your votes in this topic", err)
	}
	votes := make([]map[string]any, 0, len(voteRows))
	for _, rec := range voteRows {
		votes = append(votes, map[string]any{
			"id":         rec.Id,
			"post_id":    rec.GetString("post_id"),
			"topic_id":   rec.GetString("topic_id"),
			"target_id":  rec.GetString("target_id"),
			"voter_id":   rec.GetString("voter_id"),
			"value":      rec.GetInt("value"),
			"comment":    rec.GetString("comment"),
			"created_at": rec.GetDateTime("created").String(),
		})
	}

	return e.JSON(http.StatusOK, map[string]any{
		"topic_id":   topic.Id,
		"draft":      draft,
		"subscribed": subscribed,
		"votes":      votes,
		"request_id": requestIDFrom(e),
	})
}
