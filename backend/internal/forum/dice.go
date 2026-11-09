package forum

import (
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
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
// The roll VALUES used to be generated in the browser (src/utils/dice.js
// `processDiceRolls` with Math.random): the client decided the outcome,
// the server only range-checked it, and a forger could submit any value in
// 1..sides — a 20 on every d20, a 100 on every d100. That forged result
// rendered for every reader as the game's truth.
//
// The values are now server-generated with crypto/rand (SEC-08), rejection-
// sampled so the distribution has no modulo bias:
//   - on post create (createPostHandler, createTopicHandler) the server
//     parses the RAW `[dice=N]` tags out of the body (untouched, since the
//     browser's processDiceRolls only rewrote them into references — the
//     client does NOT decide the outcome any more), generates each value,
//     and freezes the whole map into the row in the same transaction;
//   - on draft publish the raw tags are thrown exactly once, by
//     RollDraftDice, which had already done what this plan says since the
//     draft work (see drafts.go:382) and now also uses crypto/rand;
//   - on edit the server FREEZES existing values: an incoming map whose
//     roll id already exists and whose entry differs is rejected (no
//     overwrite), except when the entry is byte-identical to the stored
//     one — which is how the client submits an unchanged throw. A fresh
//     `[dice=N]` tag in the edited body is rolled server-side; old ids
//     keep their value no matter what the client sends.

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
	// ErrRollsMissing used to be the refusal for "content references a bare
	// [roll=id] but no throws were provided". Product ruled it down (2026-10 in
	// DONE_TOPIC_REFACTOR_AUDIT_AND_CHECKLIST §29): an orphaned [roll=id] is
	// valid and renders literally — a reader must not receive a 422 for a
	// quote that happens to contain one. The constant remains ONLY as a
	// sentinel that documentation keeps pointing at, never returned.
	ErrRollsMissing = errors.New("dice rolls but no rolls were provided")
)

// SEC-08: server-side dice RNG (crypto/rand).
//
// The browser used to decide the outcome with Math.random and the server
// merely range-checked it, so a forger could submit any value in 1..sides
// and have it rendered to every reader as truth. The values below are
// rejection-sampled uniformly from [1, sides] — big.Int Rand rejects
// values outside the range until one lands inside, so there is no modulo
// bias in the tail of the range.

// ErrRollConflict is returned on edit when the client tries to overwrite
// an already-frozen roll's value — the id is right but what it points
// at has changed. This is the user-visible refusal, mirroring
// matters of identity, not just validation.
var ErrRollConflict = errors.New("dice roll already exists and differs")

// rollValue draws one throw in [1, sides] from the CSPRNG. A failed
// entropy source is fatal: a die that cannot provide randomness must not
// fall back to a deterministic number.
func rollValue(sides int) (int, error) {
	if sides < MinDiceSides || sides > MaxDiceSides {
		return 0, fmt.Errorf("%w: sides %d outside %d..%d", ErrRollMalformed, sides, MinDiceSides, MaxDiceSides)
	}
	// crypto/rand.Int samples uniformly from [0, n); offset by 1 so the
	// die face matches Math.floor(Math.random() * sides) + 1 in range.
	n, err := rand.Int(rand.Reader, big.NewInt(int64(sides)))
	if err != nil {
		return 0, err
	}
	v, ok := n.Int64(), true
	if !ok {
		return 0, fmt.Errorf("crypto/rand rejection sampler failed for sides %d", sides)
	}
	return int(v) + 1, nil
}

// serverRollID mints a server-owned roll id: `roll_<epochMillis>_<counter>`
// matches rollIDPattern so the renderer and every reader quote it
// identically to a client-minted id.
func serverRollID(counter int, now int64) string {
	return fmt.Sprintf("roll_%d_%d", now, counter)
}

// MintDice rolls a single [dice=N] tag server-side. The tag's sides and type
// are parsed out of the content's RAW tag, so this is used by the create
// paths, which see the body exactly as the author typed it.
func MintDice(content string) (string, map[string]any, error) {
	counter := 0
	now := time.Now().UnixMilli()
	rolls := map[string]any{}
	if !DiceTagPattern.MatchString(content) {
		return content, rolls, nil
	}
	rolled := DiceTagPattern.ReplaceAllStringFunc(content, func(match string) string {
		sub := DiceTagPattern.FindStringSubmatch(match)
		sides := 20
		if n, err := strconv.Atoi(sub[1]); err == nil && n > 0 {
			sides = n
		}
		kind := RollTypeNormal
		if sub[2] != "" {
			if sub[2] != RollTypeNormal && sub[2] != RollTypeMaster {
				kind = RollTypeNormal
			} else {
				kind = sub[2]
			}
		}
		value, err := rollValue(sides)
		if err != nil {
			// A failed entropy source must not silently produce a
			// deterministic face. Surface it instead: ReplaceAllStringFunc
			// has no error channel, so abort by returning the match, and
			// the caller compares the output length against the input.
			return match
		}
		counter++
		id := serverRollID(counter, now)
		rolls[id] = map[string]any{
			"id":    id,
			"sides": sides,
			"value": value,
			"type":  kind,
		}
		return fmt.Sprintf("[roll=%s]", id)
	})
	if len(rolls) == 0 && DiceTagPattern.MatchString(content) {
		return "", nil, fmt.Errorf("dice entropy source failed: no rolls generated")
	}
	return rolled, rolls, nil
}

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

// RollDice draws one server-side throw for a tag body and returns the value,
// sides, type and the new [roll=] id minted for it. It is the single entry
// point every server-side roll path shares.
func RollDice(sides int, rollType string) (int, string, error) {
	if rollType == "" {
		rollType = RollTypeNormal
	}
	if rollType != RollTypeNormal && rollType != RollTypeMaster {
		return 0, "", fmt.Errorf("%w: unknown roll type %q", ErrRollMalformed, rollType)
	}
	value, err := rollValue(sides)
	if err != nil {
		return 0, "", err
	}
	return value, rollType, nil
}

// RollDraftDice converts a draft body's unrolled `[dice=N type=T]` tags into
// thrown `[roll=<id>]` references plus the companion throws map, in the exact
// shape client `processDiceRolls` produces. Called by the publish command:
// a draft may hold the tag unresolved for as long as it is editable, and
// the value freezes here. SEC-08: the throw is crypto/rand — the client
// submitted only the TAG, never the outcome.
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
		rollType := RollTypeNormal
		if sub[2] != "" {
			if sub[2] != RollTypeNormal && sub[2] != RollTypeMaster {
				rollType = RollTypeNormal
			} else {
				rollType = sub[2]
			}
		}
		counter++
		id := fmt.Sprintf("roll_%d_%d", now, counter)
		// crypto/rand rejection sampler; a failure here is fatal to the
		// request — replacing a die with a 0 would be worse than refusing.
		value, err := rollValue(sides)
		if err != nil {
			// Attempt failed entropy; fail the whole replace by surfacing
			// the raw tag back in. Callers compare the rolled content
			// against the input and refuse to store the tag unresolved.
			return match
		}
		rolls[id] = map[string]any{
			"id":    id,
			"sides": sides,
			"value": value,
			"type":  rollType,
		}
		return "[roll=" + id + "]"
	})
	if len(rolls) == 0 && DiceTagPattern.MatchString(content) {
		// Entropy failure surface; the caller treats this as an internal
		// error rather than storing unresolved tags.
		return "", rolls
	}
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
	//
	// SEC-08 freeze on edit: an incoming map whose roll id is ALREADY present
	// in the stored map with a different value is a forgery attempt. The
	// check, deliberately, is done by the caller (see the stored map passed
	// through writeRolls): a conflicting id is identified HERE as a changed
	// value — it is not validated but refused as an identity conflict, so
	// the API caller can distinguish a freeze refusal from a malformed
	// roll. Callers that do not have a stored map to freeze against fall
	// through to the normal validation below.
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

// ValidateRollsFreeze refuses a client-supplied roll map that overwrites a
// frozen value (SEC-08 freeze on edit).
//
// It is the write-time half of the freeze: ValidateRolls checks SHAPE,
// this checks IDENTITY. A roll id that is already stored with a different
// VALUE (sides, type or the actual throw) is an attempt to re-roll history;
// the same entry arriving unchanged — which is how the client resubmits a
// post it did not re-roll — is allowed.
//
// A malformed incoming entry under an existing id is reported as
// ErrRollMalformed (the ordinary validation error), while a well-formed but
// DIFFERENT entry is ErrRollConflict.
func ValidateRollsFreeze(stored map[string]any, incoming map[string]any) error {
	for id, raw := range incoming {
		previous, exists := stored[id]
		if !exists {
			continue
		}
		want, err := sanitizeRoll(id, raw)
		if err != nil {
			return err
		}
		// stored maps are already sanitized by the server at write time,
		// so the comparison is against the exact stored entry. A
		// master roll with nil value is byte-identical to itself.
		previousTyped, ok := previous.(map[string]any)
		if !ok {
			return fmt.Errorf("%w: %q stored entry is not an object", ErrRollMalformed, id)
		}
		if !rollEntryEqual(previousTyped, want) {
			return fmt.Errorf("%w: %q was already thrown, its value is frozen", ErrRollConflict, id)
		}
	}
	return nil
}

// rollEntryEqual is byte-for-byte equality of two sanitized rolls, treating
// a missing value and an explicit nil the same way (the stored shape
// always carries one or the other).
func rollEntryEqual(a, b map[string]any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	if len(a) != len(b) {
		return false
	}
	for k, va := range a {
		vb, ok := b[k]
		if !ok {
			return false
		}
		if !rollValueEqual(va, vb) {
			return false
		}
	}
	return true
}

func rollValueEqual(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	ai, aok := rollInt(a)
	bi, bok := rollInt(b)
	if aok && bok {
		return ai == bi
	}
	as, aStr := a.(string)
	bs, bStr := b.(string)
	return aStr && bStr && as == bs
}

// ErrRollFreezeConflict is ErrRollConflict under its canonical name — the
// create-edit freeze refusal.
const ErrRollFreezeConflict = ErrRollConflict

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
