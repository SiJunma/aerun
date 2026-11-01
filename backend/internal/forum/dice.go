package forum

import (
	"errors"
	"fmt"
	"math/rand"
	"regexp"
	"strconv"
	"time"
)

// Dice rolls (migration 1768200000).
//
// `processDiceRolls` in the browser rewrites every `[dice=N]` tag into a
// `[roll=<id>]` reference plus a companion entry:
//
//	roll_1730000000000_1 -> { id, sides, value, type, timestamp }
//
// The TAG carries no number, so the companion map IS the result of the throw.
// That is why the schema has to carry it: a post whose `rolls` never reaches
// the database still renders its `[roll=…]` text — the exact "raw bbcode seen
// by a guest" report this file exists to close. Firestore stored the map on
// the post document; PocketBase needs a column for it.
//
// Two properties are enforced HERE rather than trusted:
//
//   - A roll is only accepted when the post text actually references its id.
//     Otherwise a client could stuff the column with entries no renderer will
//     read. The check is not "every reference has an entry": the quote builder
//     bakes roll values inline into the quoted copy, so a `[roll=…]` with no
//     companion entry is a legitimate thing to find in a body.
//   - Every numeric field is range-checked. `value` must sit inside `sides`,
//     because a stored `value=99` on a d20 is a die that lies about itself.
//
// MASTER ROLLS are the security-relevant half. `[dice=100 type=master]` is a
// throw the author wants hidden from the players, and `view_master_dice`
// exists in the permission matrix precisely to decide who may read it. The
// value is therefore withheld by the SERVER at read time — a value handed to
// the browser and merely not painted is a value the reader already has.
// RedactRolls does that, and it is the only place the rule is applied.
//
// The roll itself is still generated in the browser. That is the legacy
// contract (the retired callable stored whatever the client sent) and the
// reason the optimistic card can show a number before the write lands.
// Server-side RNG would be the stronger design; it is a deliberate non-goal
// here, and the one thing this package does NOT do is vouch for the numbers
// being fair.

const (
	// MaxRollsPerPost caps how many rolls one post may carry. The client has no
	// reason to produce more than a handful, and the column is JSON, so an
	// unbounded map is an unbounded row.
	MaxRollsPerPost = 64
	// MinDiceSides / MaxDiceSides bound `sides`. The editor offers d4..d100;
	// the ceiling is generous but finite, so `sides` cannot be used as a
	// smuggling primitive.
	MinDiceSides = 2
	MaxDiceSides = 1000

	// RollTypeNormal is an ordinary roll, visible to every reader.
	RollTypeNormal = "normal"
	// RollTypeMaster is a roll hidden from readers without `view_master_dice`.
	RollTypeMaster = "master"
)

var (
	// ErrRollsTooMany is returned when a post carries more rolls than the cap.
	ErrRollsTooMany = errors.New("a post may carry at most 64 dice rolls")
	// ErrRollMalformed is returned for a roll the server refuses to store. It is
	// deliberately fatal rather than silently dropped: a client whose dice
	// processing is broken would otherwise produce posts that quietly lose
	// their throws, which is the bug this whole file exists to prevent.
	ErrRollMalformed = errors.New("malformed dice roll")
)

// rollIDPattern matches the id shape `processDiceRolls` mints:
// `roll_<epochMillis>_<counter>`.
var rollIDPattern = regexp.MustCompile(`^roll_[0-9]{1,20}_[0-9]{1,6}$`)

// rollRefPattern finds the `[roll=<id>]` references in a post body. Stopping at
// the `=` keeps the character class to the id itself, so a tag carrying inline
// parameters (`[roll=x value=3 sides=20]`, which is what the quote builder
// emits) resolves to `x` and nothing more.
var rollRefPattern = regexp.MustCompile(`\[roll=([A-Za-z0-9_]+)`)

// ReferencedRollIDs returns the roll ids the content actually points at.
func ReferencedRollIDs(content string) map[string]bool {
	out := map[string]bool{}
	for _, match := range rollRefPattern.FindAllStringSubmatch(content, -1) {
		out[match[1]] = true
	}
	return out
}

// ValidateRolls checks a client-supplied roll map against the post body and
// returns the subset worth storing.
//
// A roll the text does not reference is DROPPED, not rejected; a referenced
// roll that is itself malformed is rejected, because storing it would either
// fail the render or store a die that lies. An empty result means "no rolls",
// which callers store as an empty object — see writeRolls.

// DraftDicePattern finds the client's unrolled `[dice=N type=T]` tag in a
// draft body. Drafts are stored with the tag RAW — the throw must happen at
// publication, not while the throw is still editable.
var DiceTagPattern = regexp.MustCompile(`\[dice=(\d+)(?:\s+type=([a-z]+))?\]`)

// RollDraftDice converts a draft body's unrolled `[dice=N type=T]` tags into
// thrown `[roll=<id>]` references plus the companion throws map, in the exact
// shape client `processDiceRolls` produces. Called by the publish command: a
// draft may hold the tag unresolved for as long as it is editable, and the
// value freezes only when the post becomes real.
func RollDraftDice(content string) (string, map[string]any) {
	rolls := map[string]any{}
	counter := 0
	now := time.Now().UnixMilli()
	rolled := DiceTagPattern.ReplaceAllStringFunc(content, func(match string) string {
		sub := DiceTagPattern.FindStringSubmatch(match)
		sides := 20
		if n, err := strconv.Atoi(sub[1]); err == nil && n > 0 {
			sides = n
		}
		rollType := sub[2]
		if rollType == "" {
			rollType = RollTypeNormal
		}
		counter++
		id := fmt.Sprintf("roll_%d_%d", now, counter)
		value := rand.Intn(sides) + 1
		rolls[id] = map[string]any{
			"id":    id,
			"sides": sides,
			"value": value,
			"type":  rollType,
		}
		return "[roll=" + id + "]"
	})
	return rolled, rolls
}

func ValidateRolls(content string, incoming map[string]any) (map[string]any, error) {
	// The throws map is an APPEND-ONLY AUDIT TRAIL, not a projection of the
	// body: "Dice thrown: N" counts every throw the map holds, while the
	// chips render only the ones the CURRENT body still references. When the
	// two disagree (more throws than visible chips), the post has been
	// re-rolled through an edit — that discrepancy is the tampering evidence
	// the counter exists to surface, so unreferenced entries ACCUMULATE here
	// instead of being silently dropped. Malformed entries are still checked:
	// one the body references is a broken throw in THIS post (reject the
	// write); one the body cannot even name is dropped rather than failing
	// the whole edit.
	if len(incoming) == 0 {
		return nil, nil
	}
	if len(incoming) > MaxRollsPerPost {
		return nil, ErrRollsTooMany
	}

	referenced := ReferencedRollIDs(content)
	clean := make(map[string]any, len(incoming))
	for id, raw := range incoming {
		roll, err := sanitizeRoll(id, raw)
		if err != nil {
			if referenced[id] {
				return nil, err
			}
			continue
		}
		clean[id] = roll
	}
	// Duplicates inside the body are fine: two tags pointing at one entry
	// render the same throw twice, while the "dice thrown" counter counts
	// keys — one per throw.
	if len(clean) == 0 {
		return nil, nil
	}
	return clean, nil
}

// sanitizeRoll normalises one roll entry into the stored shape
// `{id, sides, value, type}`.
//
// `timestamp` is dropped on purpose: the client stamps it, nothing reads it,
// and a stored value the server did not derive is one more thing that can
// disagree with the row it describes.
func sanitizeRoll(id string, raw any) (map[string]any, error) {
	if !rollIDPattern.MatchString(id) {
		return nil, fmt.Errorf("%w: %q is not a roll id", ErrRollMalformed, id)
	}
	entry, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%w: %q is not an object", ErrRollMalformed, id)
	}

	sides, ok := rollInt(entry["sides"])
	if !ok || sides < MinDiceSides || sides > MaxDiceSides {
		return nil, fmt.Errorf("%w: %q has an unusable sides value", ErrRollMalformed, id)
	}

	kind, _ := entry["type"].(string)
	if kind == "" {
		kind = RollTypeNormal
	}
	if kind != RollTypeNormal && kind != RollTypeMaster {
		return nil, fmt.Errorf("%w: %q has an unknown type %q", ErrRollMalformed, id, kind)
	}

	out := map[string]any{
		"id":    id,
		"sides": sides,
		"type":  kind,
	}

	if rawValue, present := entry["value"]; present && rawValue != nil {
		value, ok := rollInt(rawValue)
		if !ok || value < 1 || value > sides {
			return nil, fmt.Errorf("%w: %q has a value outside 1..%d", ErrRollMalformed, id, sides)
		}
		out["value"] = value
		return out, nil
	}

	// A master roll with no value is the author saying "this one is hidden",
	// which the renderer already understands. A NORMAL roll without a value is
	// not a roll at all.
	if kind == RollTypeMaster {
		out["value"] = nil
		return out, nil
	}
	return nil, fmt.Errorf("%w: %q carries no value", ErrRollMalformed, id)
}

// RedactRolls returns a copy of a stored roll map with every master value
// replaced by null unless the reader may see it.
//
// Copying is not defensive style: the input is the record's own map, shared by
// every payload built from that row, so redacting in place would blank the
// value for the NEXT reader too — including the moderator who is allowed to
// see it. A null value is exactly what BBCode already renders as
// "Master Roll (hidden)", so honouring this needs no client change.
func RedactRolls(rolls map[string]any, canViewMaster bool) map[string]any {
	if len(rolls) == 0 {
		return nil
	}
	out := make(map[string]any, len(rolls))
	for id, raw := range rolls {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		copied := make(map[string]any, len(entry))
		for k, v := range entry {
			copied[k] = v
		}
		if !canViewMaster && copied["type"] == RollTypeMaster {
			copied["value"] = nil
		}
		out[id] = copied
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// rollInt reads a JSON number as an int.
//
// JSON decodes every number as float64, so that case is the normal one on the
// request path; the integer cases exist for maps assembled in Go (the importer).
// A fractional value is refused rather than truncated: `sides = 20.5` is not a
// die, and rounding it would store something the author never rolled.
func rollInt(raw any) (int, bool) {
	switch value := raw.(type) {
	case int:
		return value, true
	case int64:
		return int(value), true
	case float64:
		if value != float64(int(value)) {
			return 0, false
		}
		return int(value), true
	case float32:
		if value != float32(int(value)) {
			return 0, false
		}
		return int(value), true
	default:
		return 0, false
	}
}
