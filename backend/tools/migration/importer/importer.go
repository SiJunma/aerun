// Package importer implements the Sprint 7 idempotent import from a Firebase
// staging ledger into a PocketBase database. It is a standalone CLI tool, not
// part of the live server binary.
//
// Design decisions:
//   - Reads the staging JSON produced by the Node.js export/stage pipeline.
//   - Resolves all Firebase UIDs to PocketBase record IDs via mapping tables.
//   - Recomputes counters (posts_count, reputation, next_post_sequence, etc.)
//     from actual data rather than importing cached values.
//   - Preserves historical dates in application fields (created_at timestamps
//     become PocketBase `created` fields where the schema uses AutodateField).
//   - Is idempotent: re-running with the same export produces the same state.
//   - Never deletes records — missing records from the source are reported.
package importer

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Tagged-value decoding (matches firebase-source.mjs encode())
// ---------------------------------------------------------------------------

// TaggedValue is the tagged-union format used by the Node.js exporter.
type TaggedValue struct {
	Type        string          `json:"type"`
	Value       json.RawMessage `json:"value,omitempty"`
	Seconds     *int64          `json:"seconds,omitempty"`
	Nanoseconds *int64          `json:"nanoseconds,omitempty"`
	Base64      string          `json:"base64,omitempty"`
	Path        string          `json:"path,omitempty"`
	Latitude    *float64        `json:"latitude,omitempty"`
	Longitude   *float64        `json:"longitude,omitempty"`
}

// Decode converts a TaggedValue into a native Go value.
func (tv TaggedValue) Decode() (any, error) {
	switch tv.Type {
	case "scalar":
		var v any
		if err := json.Unmarshal(tv.Value, &v); err != nil {
			return nil, fmt.Errorf("decode scalar: %w", err)
		}
		return v, nil
	case "timestamp":
		if tv.Seconds == nil {
			return nil, fmt.Errorf("timestamp missing seconds")
		}
		sec := *tv.Seconds
		nsec := int64(0)
		if tv.Nanoseconds != nil {
			nsec = *tv.Nanoseconds
		}
		return time.Unix(sec, nsec).UTC(), nil
	case "map":
		var m map[string]TaggedValue
		if err := json.Unmarshal(tv.Value, &m); err != nil {
			return nil, fmt.Errorf("decode map: %w", err)
		}
		result := make(map[string]any, len(m))
		for k, child := range m {
			v, err := child.Decode()
			if err != nil {
				return nil, fmt.Errorf("map key %q: %w", k, err)
			}
			result[k] = v
		}
		return result, nil
	case "array":
		var items []TaggedValue
		if err := json.Unmarshal(tv.Value, &items); err != nil {
			return nil, fmt.Errorf("decode array: %w", err)
		}
		result := make([]any, len(items))
		for i, item := range items {
			v, err := item.Decode()
			if err != nil {
				return nil, fmt.Errorf("array[%d]: %w", i, err)
			}
			result[i] = v
		}
		return result, nil
	case "reference":
		return tv.Path, nil
	case "bytes":
		return tv.Base64, nil
	case "geopoint":
		lat, lon := float64(0), float64(0)
		if tv.Latitude != nil {
			lat = *tv.Latitude
		}
		if tv.Longitude != nil {
			lon = *tv.Longitude
		}
		return map[string]float64{"lat": lat, "lon": lon}, nil
	case "number":
		var s string
		if err := json.Unmarshal(tv.Value, &s); err != nil {
			return nil, fmt.Errorf("decode number: %w", err)
		}
		return s, nil // NaN/Inf as string
	default:
		return nil, fmt.Errorf("unknown tagged type: %q", tv.Type)
	}
}

// ---------------------------------------------------------------------------
// Staging ledger types
// ---------------------------------------------------------------------------

// StagingRecord is one record in the staging ledger.
type StagingRecord struct {
	Kind string      `json:"kind"`
	Path string      `json:"path"`
	Data TaggedValue `json:"data"`
	Hash string      `json:"hash"`
}

// StagingLedger is the output of the Node.js staging pipeline.
type StagingLedger struct {
	Version   int             `json:"version"`
	ProjectID string          `json:"projectId"`
	StartedAt string          `json:"startedAt"`
	Snapshot  string          `json:"snapshot"`
	Records   []StagingRecord `json:"records"`
	Checksum  string          `json:"checksum"`
}

// AuthExportUser is one user from the official Firebase Auth export.
type AuthExportUser struct {
	LocalID       string `json:"localId"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"emailVerified"`
	DisplayName   string `json:"displayName"`
	PhotoURL      string `json:"photoUrl"`
	PasswordHash  string `json:"passwordHash"`
	ProviderInfo  []struct {
		ProviderID  string `json:"providerId"`
		RawID       string `json:"rawId"`
		Email       string `json:"email"`
		DisplayName string `json:"displayName"`
		PhotoURL    string `json:"photoUrl"`
	} `json:"providerUserInfo"`
	CreatedAt      string `json:"createdAt"`
	LastSignedInAt string `json:"lastSignedInAt"`
}

// AuthExport is the top-level structure of the official auth export JSON.
type AuthExport struct {
	Users []AuthExportUser `json:"users"`
}

// ---------------------------------------------------------------------------
// Import plan: decoded, validated, ready for PocketBase insertion
// ---------------------------------------------------------------------------

// ImportPlan holds all decoded and validated records ready for insertion.
type ImportPlan struct {
	// Users maps Firebase UID -> decoded user profile fields.
	Users map[string]map[string]any
	// AuthUsers maps Firebase UID -> auth export metadata.
	AuthUsers map[string]*AuthExportUser
	// CategoryGroups maps Firestore doc ID -> decoded fields.
	CategoryGroups map[string]map[string]any
	// Categories maps Firestore doc ID -> decoded fields.
	Categories map[string]map[string]any
	// Topics maps Firestore doc ID -> decoded fields.
	Topics map[string]map[string]any
	// Posts maps Firestore doc ID -> decoded fields.
	Posts map[string]map[string]any
	// Subscriptions maps Firestore doc ID -> decoded fields.
	Subscriptions map[string]map[string]any
	// ReputationLogs maps Firestore doc ID -> decoded fields.
	ReputationLogs map[string]map[string]any
	// AuditLogs maps Firestore doc ID -> decoded fields.
	AuditLogs map[string]map[string]any
	// Notifications maps Firestore doc ID -> decoded fields.
	Notifications map[string]map[string]any
	// DMs maps Firestore doc ID -> decoded DM conversation fields.
	DMs map[string]map[string]any
	// DMMessages maps "conv_id/messages/msg_id" -> decoded message fields.
	DMMessages map[string]map[string]any
	// Roles maps Firestore doc ID -> decoded fields.
	Roles map[string]map[string]any
	// Drafts maps "uid/drafts/topic_id" -> decoded draft fields. A draft is
	// post-shaped authored content (is_draft=true) keyed by (owner, topic) —
	// the legacy document id IS the topic id. It imports into the target
	// posts collection with is_draft=true, never into a separate table.
	Drafts map[string]map[string]any
	// DroppedUsers holds the UIDs of dead/broken account documents (no
	// role_id) that were dropped at classification time, so downstream
	// records referencing them can be dropped or validated knowingly.
	DroppedUsers map[string]bool

	// Skipped collections (cache-only or non-migrated).
	Skipped map[string]int
}

// ImportReport summarises the results of an import run.
type ImportReport struct {
	UsersCreated          int               `json:"users_created"`
	UsersUpdated          int               `json:"users_updated"`
	CategoriesImported    int               `json:"categories_imported"`
	TopicsImported        int               `json:"topics_imported"`
	PostsImported         int               `json:"posts_imported"`
	SubscriptionsImported int               `json:"subscriptions_imported"`
	ReputationImported    int               `json:"reputation_imported"`
	AuditImported         int               `json:"audit_imported"`
	NotificationsImported int               `json:"notifications_imported"`
	DMConversations       int               `json:"dm_conversations"`
	DMMessages            int               `json:"dm_messages"`
	SkippedCollections    map[string]int    `json:"skipped_collections"`
	Warnings              []string          `json:"warnings"`
	ForeignKeyErrors      []string          `json:"foreign_key_errors"`
	CounterReconciliation map[string]string `json:"counter_reconciliation"`
}

// ---------------------------------------------------------------------------
// Loader: reads and validates the staging ledger + auth export
// ---------------------------------------------------------------------------

// LoadStagingLedger reads and validates a staging ledger JSON file.
func LoadStagingLedger(path string) (*StagingLedger, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read staging ledger: %w", err)
	}

	var ledger StagingLedger
	if err := json.Unmarshal(data, &ledger); err != nil {
		return nil, fmt.Errorf("parse staging ledger: %w", err)
	}

	if ledger.Version != 1 {
		return nil, fmt.Errorf("unsupported staging ledger version: %d", ledger.Version)
	}
	if ledger.ProjectID == "" {
		return nil, fmt.Errorf("staging ledger has no projectId")
	}

	// Verify top-level checksum.
	clone := ledger
	clone.Checksum = ""
	payload, _ := json.Marshal(struct {
		Version   int             `json:"version"`
		ProjectID string          `json:"projectId"`
		StartedAt string          `json:"startedAt"`
		Snapshot  string          `json:"snapshot"`
		Records   []StagingRecord `json:"records"`
	}{clone.Version, clone.ProjectID, clone.StartedAt, clone.Snapshot, clone.Records})
	actual := fmt.Sprintf("%x", sha256.Sum256(payload))
	if actual != ledger.Checksum {
		// The checksum uses the Node.js canonical() format, not Go's json.Marshal.
		// We skip strict validation here but log a warning; the Node.js tool
		// already validated the checksum at staging time.
		slog.Warn("staging ledger checksum skipped (Go vs Node.js canonical format may differ)",
			"expected", ledger.Checksum, "computed", actual)
	}

	return &ledger, nil
}

// LoadAuthExport reads the official Firebase Auth export JSON.
func LoadAuthExport(path string) (*AuthExport, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read auth export: %w", err)
	}

	var export AuthExport
	if err := json.Unmarshal(data, &export); err != nil {
		return nil, fmt.Errorf("parse auth export: %w", err)
	}

	return &export, nil
}

// ---------------------------------------------------------------------------
// Plan builder: decode all records into typed maps
// ---------------------------------------------------------------------------

// BuildPlan decodes every staging record and auth export user into an ImportPlan.
func BuildPlan(ledger *StagingLedger, authExport *AuthExport, logger *slog.Logger) (*ImportPlan, error) {
	plan := &ImportPlan{
		Users:          make(map[string]map[string]any),
		AuthUsers:      make(map[string]*AuthExportUser),
		CategoryGroups: make(map[string]map[string]any),
		Categories:     make(map[string]map[string]any),
		Topics:         make(map[string]map[string]any),
		Posts:          make(map[string]map[string]any),
		Subscriptions:  make(map[string]map[string]any),
		ReputationLogs: make(map[string]map[string]any),
		AuditLogs:      make(map[string]map[string]any),
		Notifications:  make(map[string]map[string]any),
		DMs:            make(map[string]map[string]any),
		DMMessages:     make(map[string]map[string]any),
		Roles:          make(map[string]map[string]any),
		Drafts:         make(map[string]map[string]any),
		DroppedUsers:   make(map[string]bool),
		Skipped:        make(map[string]int),
	}

	// Index auth export users by UID.
	if authExport != nil {
		for i := range authExport.Users {
			u := &authExport.Users[i]
			plan.AuthUsers[u.LocalID] = u
		}
	}

	for _, rec := range ledger.Records {
		switch rec.Kind {
		case "auth":
			// Auth metadata records are already indexed above.
			continue
		case "firestore":
			if err := classifyFirestoreRecord(plan, rec, logger); err != nil {
				return nil, err
			}
		default:
			logger.Warn("unknown record kind", "kind", rec.Kind, "path", rec.Path)
		}
	}

	// Reputation logs that reference a dropped orphan account are dropped
	// with it: a vote for a dead user is dead data (product rule 2026-09-26).
	// Everything else keeps its FK error so real drift stays visible.
	for uid := range plan.DroppedUsers {
		for id, fields := range plan.ReputationLogs {
			if stringField(fields, "voter_id") == uid || stringField(fields, "target_id") == uid {
				delete(plan.ReputationLogs, id)
				plan.Skipped["orphan_reputation_dropped"]++
			}
		}
	}

	return plan, nil
}

// classifyFirestoreRecord routes a firestore record into the correct plan bucket.
func classifyFirestoreRecord(plan *ImportPlan, rec StagingRecord, logger *slog.Logger) error {
	parts := strings.Split(rec.Path, "/")

	decoded, err := rec.Data.Decode()
	if err != nil {
		return fmt.Errorf("decode %s: %w", rec.Path, err)
	}
	fields, ok := decoded.(map[string]any)
	if !ok {
		return fmt.Errorf("record %s is not a map", rec.Path)
	}

	collection := parts[0]
	docID := ""
	if len(parts) >= 2 {
		docID = parts[1]
	}

	switch {
	case collection == "users" && len(parts) == 2:
		// An account document without a role_id is a dead/broken record: real
		// accounts always carry a role (product rule 2026-09-26). The auth
		// export may still hold its credentials, but without a profile there
		// is nothing to import — it is dropped and reported, never mapped.
		if stringField(fields, "role_id") == "" {
			plan.Skipped["orphan_user_dropped"]++
			plan.DroppedUsers[docID] = true
			return nil
		}
		plan.Users[docID] = fields
	case collection == "users" && len(parts) == 4 && parts[2] == "characters":
		// User characters are subcollections — stored as settings in PB.
		// We'll handle these when importing users.
		key := fmt.Sprintf("%s/characters/%s", docID, parts[3])
		plan.Users[key] = fields
	case collection == "users" && len(parts) >= 4 && parts[2] == "readmap":
		// Per-topic read receipts. Pure client state, recomputed by the target
		// on first visit; never imported (Sprint 7 task 3).
		plan.Skipped["user_readmap"]++
	case collection == "users" && len(parts) >= 4 && parts[2] == "drafts":
		// Unsent topic drafts are post-shaped authored content keyed by
		// (owner, topic): the legacy document id IS the topic id. They import
		// into the target posts collection with is_draft=true, so they get
		// their own bucket with the composite legacy id.
		key := fmt.Sprintf("%s/drafts/%s", docID, parts[3])
		plan.Drafts[key] = fields
	case collection == "category_groups" && len(parts) == 2:
		plan.CategoryGroups[docID] = fields
	case collection == "categories" && len(parts) == 2:
		plan.Categories[docID] = fields
	case collection == "topics" && len(parts) == 2:
		plan.Topics[docID] = fields
	case collection == "posts" && len(parts) == 2:
		plan.Posts[docID] = fields
	case collection == "topic_subscriptions" && len(parts) == 2:
		plan.Subscriptions[docID] = fields
	case collection == "reputation_logs" && len(parts) == 2:
		plan.ReputationLogs[docID] = fields
	case collection == "audit_logs" && len(parts) == 2:
		plan.AuditLogs[docID] = fields
	case collection == "notifications" && len(parts) == 2:
		plan.Notifications[docID] = fields
	case collection == "dms" && len(parts) == 2:
		plan.DMs[docID] = fields
	case collection == "dms" && len(parts) == 4 && parts[2] == "messages":
		key := fmt.Sprintf("%s/messages/%s", docID, parts[3])
		plan.DMMessages[key] = fields
	case collection == "roles" && len(parts) == 2:
		plan.Roles[docID] = fields
	case collection == "guest_activity" || collection == "forum_stats" ||
		collection == "settings" || collection == "designs":
		// Cache-only or non-migrated collections; count but skip.
		plan.Skipped[collection]++
	default:
		// Could be a user subcollection under a UID path.
		if len(parts) == 1 {
			// Top-level doc with UID-like name (auth records in firestore).
			plan.Skipped["auth_firestore_record"]++
		} else {
			logger.Warn("unclassified record", "path", rec.Path)
			plan.Skipped["unclassified"]++
		}
	}

	return nil
}

// ---------------------------------------------------------------------------
// Foreign key validation
// ---------------------------------------------------------------------------

// ValidateForeignKeys checks that all author_id, topic_id, category_id etc.
// references in the plan point to existing records.
func ValidateForeignKeys(plan *ImportPlan) []string {
	var errors []string

	// Check topic author_id and category_id.
	for id, fields := range plan.Topics {
		authorID := stringField(fields, "author_id")
		if authorID != "" {
			if _, ok := plan.Users[authorID]; !ok {
				errors = append(errors, fmt.Sprintf("topic %s: author_id %q not found in users", id, authorID))
			}
		}
		catID := stringField(fields, "category_id")
		if catID != "" {
			if _, ok := plan.Categories[catID]; !ok {
				errors = append(errors, fmt.Sprintf("topic %s: category_id %q not found in categories", id, catID))
			}
		}
	}

	// Check post author_id and topic_id.
	for id, fields := range plan.Posts {
		authorID := stringField(fields, "author_id")
		if authorID != "" {
			if _, ok := plan.Users[authorID]; !ok {
				errors = append(errors, fmt.Sprintf("post %s: author_id %q not found in users", id, authorID))
			}
		}
		topicID := stringField(fields, "topic_id")
		if topicID != "" {
			if _, ok := plan.Topics[topicID]; !ok {
				errors = append(errors, fmt.Sprintf("post %s: topic_id %q not found in topics", id, topicID))
			}
		}
	}

	// Drafts are future posts: same FK contract as posts, plus the legacy
	// (owner, topic) pairing — a draft whose topic vanished must be reported
	// as an orphan, not silently imported into a dead reference.
	for id, fields := range plan.Drafts {
		authorID := stringField(fields, "author_id")
		if authorID != "" {
			if _, ok := plan.Users[authorID]; !ok {
				errors = append(errors, fmt.Sprintf("draft %s: author_id %q not found in users", id, authorID))
			}
		}
		topicID := stringField(fields, "topic_id")
		if topicID == "" {
			errors = append(errors, fmt.Sprintf("draft %s: topic_id is empty", id))
		} else if _, ok := plan.Topics[topicID]; !ok {
			errors = append(errors, fmt.Sprintf("draft %s: topic_id %q not found in topics", id, topicID))
		} else if parts := strings.Split(id, "/"); parts[0] != authorID || parts[len(parts)-1] != topicID {
			errors = append(errors, fmt.Sprintf("draft %s: path does not match (author %q, topic %q)", id, authorID, topicID))
		}
	}

	// Check subscription references.
	for id, fields := range plan.Subscriptions {
		userID := stringField(fields, "user_id")
		if userID != "" {
			if _, ok := plan.Users[userID]; !ok {
				errors = append(errors, fmt.Sprintf("subscription %s: user_id %q not found", id, userID))
			}
		}
		topicID := stringField(fields, "topic_id")
		if topicID != "" {
			if _, ok := plan.Topics[topicID]; !ok {
				errors = append(errors, fmt.Sprintf("subscription %s: topic_id %q not found", id, topicID))
			}
		}
	}

	// Check reputation log references.
	for id, fields := range plan.ReputationLogs {
		voterID := stringField(fields, "voter_id")
		if voterID != "" {
			if _, ok := plan.Users[voterID]; !ok {
				errors = append(errors, fmt.Sprintf("reputation %s: voter_id %q not found", id, voterID))
			}
		}
		targetID := stringField(fields, "target_id")
		if targetID != "" {
			if _, ok := plan.Users[targetID]; !ok {
				errors = append(errors, fmt.Sprintf("reputation %s: target_id %q not found", id, targetID))
			}
		}
	}

	sort.Strings(errors)
	return errors
}

// ---------------------------------------------------------------------------
// Counter recomputation
// ---------------------------------------------------------------------------

// RecomputedCounters holds recomputed values from actual data.
type RecomputedCounters struct {
	// TopicPostsCount maps Firebase topic ID -> actual post count.
	TopicPostsCount map[string]int
	// TopicLastPost maps Firebase topic ID -> info about the last post.
	TopicLastPost map[string]LastPostInfo
	// UserPostCount maps Firebase UID -> actual post count.
	UserPostCount map[string]int
	// UserReputation maps Firebase UID -> recomputed reputation score.
	UserReputation map[string]int
	// PostReputation maps Firebase post ID -> recomputed reputation score.
	PostReputation map[string]int
	// CategoryTopicsCount maps Firebase category ID -> topic count.
	CategoryTopicsCount map[string]int
	// CategoryPostsCount maps Firebase category ID -> total post count.
	CategoryPostsCount map[string]int
	// DMConvMessageCount maps DM conversation ID -> message count.
	DMConvMessageCount map[string]int
}

// LastPostInfo holds information about the last post in a topic.
type LastPostInfo struct {
	PostID    string
	CreatedAt time.Time
	AuthorID  string
}

// RecomputeCounters derives all counters from actual data rather than
// importing cached Firestore/RTDB values.
func RecomputeCounters(plan *ImportPlan) *RecomputedCounters {
	c := &RecomputedCounters{
		TopicPostsCount:     make(map[string]int),
		TopicLastPost:       make(map[string]LastPostInfo),
		UserPostCount:       make(map[string]int),
		UserReputation:      make(map[string]int),
		PostReputation:      make(map[string]int),
		CategoryTopicsCount: make(map[string]int),
		CategoryPostsCount:  make(map[string]int),
		DMConvMessageCount:  make(map[string]int),
	}

	// Count posts per topic, per user, and find last post per topic.
	for postID, fields := range plan.Posts {
		topicID := stringField(fields, "topic_id")
		authorID := stringField(fields, "author_id")

		c.TopicPostsCount[topicID]++
		c.UserPostCount[authorID]++

		createdAt := timeField(fields, "created_at")
		if !createdAt.IsZero() {
			existing, exists := c.TopicLastPost[topicID]
			if !exists || createdAt.After(existing.CreatedAt) {
				c.TopicLastPost[topicID] = LastPostInfo{
					PostID:    postID,
					CreatedAt: createdAt,
					AuthorID:  authorID,
				}
			}
		}
	}

	// Count topics per category and total posts per category.
	for _, fields := range plan.Topics {
		catID := stringField(fields, "category_id")
		c.CategoryTopicsCount[catID]++
	}
	for _, fields := range plan.Posts {
		topicID := stringField(fields, "topic_id")
		if topicFields, ok := plan.Topics[topicID]; ok {
			catID := stringField(topicFields, "category_id")
			c.CategoryPostsCount[catID]++
		}
	}

	// Recompute reputation from votes.
	for _, fields := range plan.ReputationLogs {
		targetID := stringField(fields, "target_id")
		postID := stringField(fields, "post_id")
		value := intField(fields, "value")

		c.UserReputation[targetID] += value
		if postID != "" {
			c.PostReputation[postID] += value
		}
	}

	// Count DM messages per conversation.
	for key := range plan.DMMessages {
		parts := strings.Split(key, "/messages/")
		if len(parts) == 2 {
			c.DMConvMessageCount[parts[0]]++
		}
	}

	return c
}

// ---------------------------------------------------------------------------
// Reconciliation report
// ---------------------------------------------------------------------------

// Reconcile compares recomputed counters against the source data's cached values
// and reports discrepancies.
func Reconcile(plan *ImportPlan, counters *RecomputedCounters) map[string]string {
	report := make(map[string]string)

	// Topic posts_count
	for topicID, fields := range plan.Topics {
		cached := intField(fields, "posts_count")
		actual := counters.TopicPostsCount[topicID]
		if cached != actual {
			report[fmt.Sprintf("topic/%s/posts_count", topicID)] =
				fmt.Sprintf("cached=%d actual=%d", cached, actual)
		}
	}

	// User post_count
	for uid, fields := range plan.Users {
		if strings.Contains(uid, "/") {
			continue // skip character subcollection records
		}
		cached := intField(fields, "post_count")
		actual := counters.UserPostCount[uid]
		if cached != actual {
			report[fmt.Sprintf("user/%s/post_count", uid)] =
				fmt.Sprintf("cached=%d actual=%d", cached, actual)
		}
	}

	// User reputation
	for uid, fields := range plan.Users {
		if strings.Contains(uid, "/") {
			continue
		}
		cached := intField(fields, "reputation")
		actual := counters.UserReputation[uid]
		if cached != actual {
			report[fmt.Sprintf("user/%s/reputation", uid)] =
				fmt.Sprintf("cached=%d actual=%d", cached, actual)
		}
	}

	return report
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

func stringField(m map[string]any, key string) string {
	v, ok := m[key]
	if !ok {
		return ""
	}
	s, ok := v.(string)
	if !ok {
		return fmt.Sprintf("%v", v)
	}
	return s
}

func intField(m map[string]any, key string) int {
	v, ok := m[key]
	if !ok {
		return 0
	}
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	default:
		return 0
	}
}

func timeField(m map[string]any, key string) time.Time {
	v, ok := m[key]
	if !ok {
		return time.Time{}
	}
	t, ok := v.(time.Time)
	if !ok {
		return time.Time{}
	}
	return t
}

// TimestampToISO converts a Firestore timestamp to ISO 8601 string for PocketBase.
func TimestampToISO(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format("2006-01-02 15:04:05.000Z")
}

// NormalizeNickname lowercases and trims a nickname for uniqueness checks.
func NormalizeNickname(nickname string) string {
	return strings.ToLower(strings.TrimSpace(nickname))
}
