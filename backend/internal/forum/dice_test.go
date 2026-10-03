package forum

import (
	"errors"
	"strconv"
	"testing"
)

const (
	testRollID  = "roll_1791050763756_1"
	testRollID2 = "roll_1791050763756_2"
)

// rollBody is the body processDiceRolls produces for one thrown die.
func rollBody(id string) string {
	return "Кубики админские\n[roll=" + id + "]\n"
}

// ── The reported failure ─────────────────────────────────────────────────────
//
// A post stored its `[roll=…]` tags and NO map, because nothing carried the
// map: BBCode's roll branch prints the raw tag when the id is absent from the
// map it was given. These tests pin the two halves together.

// TestValidateRollsKeepsWhatTheBodyReferences is the base contract: a roll the
// body points at is stored, in the shape the renderer reads.
func TestValidateRollsKeepsWhatTheBodyReferences(t *testing.T) {
	body := rollBody(testRollID)

	clean, err := ValidateRolls(body, map[string]any{
		testRollID: map[string]any{
			"id":        testRollID,
			"sides":     float64(20),
			"value":     float64(17),
			"type":      "normal",
			"timestamp": float64(1791050763756),
		},
	})
	if err != nil {
		t.Fatalf("a well-formed roll must be accepted: %v", err)
	}
	entry, ok := clean[testRollID].(map[string]any)
	if !ok {
		t.Fatalf("the referenced roll must survive validation, got %#v", clean)
	}
	if entry["sides"] != 20 {
		t.Errorf("sides = %v, want 20 (a JSON number decodes as float64)", entry["sides"])
	}
	if entry["value"] != 17 {
		t.Errorf("value = %v, want 17", entry["value"])
	}
	if entry["type"] != "normal" {
		t.Errorf("type = %v, want normal", entry["type"])
	}
	// timestamp is client-supplied and unread; storing it is a value the server
	// did not derive and can therefore disagree with.
	if _, present := entry["timestamp"]; present {
		t.Error("timestamp must not be stored: nothing reads it and the server did not derive it")
	}
}

// TestValidateRollsDropsUnreferencedRolls: an entry no tag points at is dead
// weight, and accepting it would let a client stuff the column.
func TestValidateRollsDropsUnreferencedRolls(t *testing.T) {
	clean, err := ValidateRolls(rollBody(testRollID), map[string]any{
		testRollID:  map[string]any{"sides": float64(20), "value": float64(5), "type": "normal"},
		testRollID2: map[string]any{"sides": float64(6), "value": float64(2), "type": "normal"},
	})
	if err != nil {
		t.Fatalf("unreferenced entries are dropped, not rejected: %v", err)
	}
	if _, present := clean[testRollID2]; present {
		t.Error("a roll no [roll=…] tag references must not be stored")
	}
	if _, present := clean[testRollID]; !present {
		t.Error("the referenced roll must survive")
	}
}

// TestValidateRollsAcceptsInlineQuotedRolls: the quote builder bakes values
// inline (`[roll=x value=3 sides=20]`), so such a tag legitimately has no
// companion entry and must not be treated as a broken one.
func TestValidateRollsAcceptsInlineQuotedRolls(t *testing.T) {
	body := "[quote=\"someone\"]\n[roll=" + testRollID + " value=3 sides=20]\n[/quote]"

	clean, err := ValidateRolls(body, map[string]any{})
	if err != nil {
		t.Fatalf("an inline quoted roll must not be a validation failure: %v", err)
	}
	if len(clean) != 0 {
		t.Errorf("nothing to store, got %#v", clean)
	}
}

// TestValidateRollsRefusesADieThatLies: value must sit inside sides.
func TestValidateRollsRefusesADieThatLies(t *testing.T) {
	for _, tc := range []struct {
		name  string
		entry map[string]any
	}{
		{"value above sides", map[string]any{"sides": float64(20), "value": float64(99), "type": "normal"}},
		{"value below one", map[string]any{"sides": float64(20), "value": float64(0), "type": "normal"}},
		{"sides out of range", map[string]any{"sides": float64(0), "value": float64(1), "type": "normal"}},
		{"fractional sides", map[string]any{"sides": 20.5, "value": float64(3), "type": "normal"}},
		{"unknown type", map[string]any{"sides": float64(20), "value": float64(3), "type": "loaded"}},
		{"normal roll with no value", map[string]any{"sides": float64(20), "type": "normal"}},
		{"entry is not an object", map[string]any{"sides": "twenty"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ValidateRolls(rollBody(testRollID), map[string]any{testRollID: tc.entry})
			if !errors.Is(err, ErrRollMalformed) {
				t.Fatalf("err = %v, want ErrRollMalformed", err)
			}
		})
	}
}

// TestValidateRollsRejectsAForgedId: the id is the join key, so a client cannot
// mint one to smuggle an entry past the body check.
//
// The two outcomes differ but both are safe, and the difference is the point: an
// id the body CAN reference is rejected outright, while one the body cannot even
// name (`[roll=../../etc/passwd]` — the reference pattern stops at the `/`) is
// simply unreferenced and dropped. What matters is that neither is ever stored.
func TestValidateRollsRejectsAForgedId(t *testing.T) {
	for _, id := range []string{"roll_abc_1", "roll_1", "x" + testRollID, "ROLL_1791050763756_1"} {
		t.Run(id, func(t *testing.T) {
			clean, err := ValidateRolls(rollBody(id), map[string]any{
				id: map[string]any{"sides": float64(20), "value": float64(3), "type": "normal"},
			})
			if !errors.Is(err, ErrRollMalformed) {
				t.Fatalf("a referenceable forged id must be refused, got err = %v", err)
			}
			if len(clean) != 0 {
				t.Errorf("nothing may be stored, got %#v", clean)
			}
		})
	}

	// Not referenceable at all: dropped rather than rejected, because a
	// `[roll=…]` tag carrying inline quote parameters is a legitimate thing to
	// find in a body and must not fail the whole write.
	t.Run("unreferenceable path", func(t *testing.T) {
		clean, err := ValidateRolls("[roll=../../etc/passwd]", map[string]any{
			"../../etc/passwd": map[string]any{"sides": float64(20), "value": float64(3), "type": "normal"},
		})
		if err != nil {
			t.Fatalf("must be dropped, not rejected: %v", err)
		}
		if len(clean) != 0 {
			t.Errorf("nothing may be stored, got %#v", clean)
		}
	})
}

// TestValidateRollsCapsTheNumberOfRolls bounds the column.
func TestValidateRollsCapsTheNumberOfRolls(t *testing.T) {
	incoming := map[string]any{}
	body := ""
	for i := 0; i <= MaxRollsPerPost; i++ {
		id := "roll_1791050763756_" + strconv.Itoa(i)
		body += "[roll=" + id + "]"
		incoming[id] = map[string]any{"sides": float64(6), "value": float64(1), "type": "normal"}
	}
	if _, err := ValidateRolls(body, incoming); !errors.Is(err, ErrRollsTooMany) {
		t.Fatalf("err = %v, want ErrRollsTooMany", err)
	}
}

// ── Master dice: the permission is enforced HERE, not in the renderer ────────

// TestRedactRollsHidesMasterValuesFromPlayers is the security case. Sending the
// value and trusting the renderer to keep quiet would publish it to anybody who
// opens the network tab.
func TestRedactRollsHidesMasterValuesFromPlayers(t *testing.T) {
	stored := map[string]any{
		testRollID:  map[string]any{"id": testRollID, "sides": 100, "value": 87, "type": "master"},
		testRollID2: map[string]any{"id": testRollID2, "sides": 20, "value": 13, "type": "normal"},
	}

	player := RedactRolls(stored, false)

	master := player[testRollID].(map[string]any)
	if master["value"] != nil {
		t.Errorf("a master value reached a reader without view_master_dice: %v", master["value"])
	}
	// The roll itself must survive: BBCode renders "Master Roll (hidden)" from a
	// null value, and dropping the entry would resurrect the raw-tag bug.
	if master["sides"] != 100 {
		t.Errorf("the master roll must still be described, got sides = %v", master["sides"])
	}
	normal := player[testRollID2].(map[string]any)
	if normal["value"] != 13 {
		t.Errorf("an ordinary roll must not be redacted, got %v", normal["value"])
	}

	// THE trap: the caller's map is the record's own. Redacting in place would
	// blank the value for the NEXT reader too — the moderator who may see it.
	if stored[testRollID].(map[string]any)["value"] != 87 {
		t.Error("RedactRolls mutated the map it was given; the stored value must be untouched")
	}
}

// TestRedactRollsKeepsMasterValuesForPermittedReaders: the GM must see them.
func TestRedactRollsKeepsMasterValuesForPermittedReaders(t *testing.T) {
	stored := map[string]any{
		testRollID: map[string]any{"id": testRollID, "sides": 100, "value": 87, "type": "master"},
	}

	gm := RedactRolls(stored, true)

	if gm[testRollID].(map[string]any)["value"] != 87 {
		t.Error("a reader WITH view_master_dice must see the master value")
	}
}

// TestRedactRollsPassesThroughNullMasterValues: a master die stored with no
// value must survive redaction as null, not disappear.
func TestRedactRollsPassesThroughNullMasterValues(t *testing.T) {
	stored := map[string]any{
		testRollID: map[string]any{"id": testRollID, "sides": 100, "value": nil, "type": "master"},
	}

	out := RedactRolls(stored, false)

	entry, ok := out[testRollID].(map[string]any)
	if !ok {
		t.Fatalf("a null-valued master roll must still be described, got %#v", out)
	}
	if entry["value"] != nil {
		t.Errorf("value = %v, want nil", entry["value"])
	}
}

func TestRedactRollsHandlesNothingStored(t *testing.T) {
	if out := RedactRolls(nil, false); out != nil {
		t.Errorf("RedactRolls(nil) = %#v, want nil", out)
	}
	if out := RedactRolls(map[string]any{}, true); out != nil {
		t.Errorf("RedactRolls(empty) = %#v, want nil", out)
	}
}

// TestValidateRollsAcceptsMasterRollWithoutValue: the author saying "this one
// is hidden" is a legitimate roll, not a broken one.
func TestValidateRollsAcceptsMasterRollWithoutValue(t *testing.T) {
	clean, err := ValidateRolls(rollBody(testRollID), map[string]any{
		testRollID: map[string]any{"sides": float64(100), "type": "master"},
	})
	if err != nil {
		t.Fatalf("a valueless master roll must be accepted: %v", err)
	}
	if clean[testRollID].(map[string]any)["value"] != nil {
		t.Error("value must stay nil")
	}
}

// ── The map the body points at is the only place a number lives ─────────────

// TestValidateRollsRoundTripsTwoRolls mirrors the reported post exactly: two
// dice in one body, both of which must resolve after a reload.
func TestValidateRollsRoundTripsTwoRolls(t *testing.T) {
	body := "Кубики админские\n[roll=" + testRollID + "]\nКубики публичные\n[roll=" + testRollID2 + "]"

	clean, err := ValidateRolls(body, map[string]any{
		testRollID:  map[string]any{"sides": float64(100), "value": float64(42), "type": "normal"},
		testRollID2: map[string]any{"sides": float64(20), "value": float64(7), "type": "normal"},
	})
	if err != nil {
		t.Fatalf("both dice must be accepted: %v", err)
	}
	if len(clean) != 2 {
		t.Fatalf("stored %d rolls, want 2 — a lost roll is the reported bug", len(clean))
	}
}

// TestReferencedRollIDsStopsAtTheEqualsSign: an inline-parameter tag resolves
// to its id and nothing else.
func TestReferencedRollIDsStopsAtTheEqualsSign(t *testing.T) {
	refs := ReferencedRollIDs("[roll=" + testRollID + " value=3 sides=20]")
	if !refs[testRollID] {
		t.Errorf("the id must be found in %#v", refs)
	}
	if len(refs) != 1 {
		t.Errorf("refs = %#v, want exactly one id", refs)
	}
}

// TestValidateRollsIsIdempotentAcrossAReSave: a draft is saved repeatedly and
// published verbatim, so the same map must survive being re-validated.
func TestValidateRollsIsIdempotentAcrossAReSave(t *testing.T) {
	body := rollBody(testRollID)
	incoming := map[string]any{
		testRollID: map[string]any{"sides": float64(20), "value": float64(11), "type": "normal"},
	}

	first, err := ValidateRolls(body, incoming)
	if err != nil {
		t.Fatalf("first pass: %v", err)
	}
	second, err := ValidateRolls(body, first)
	if err != nil {
		t.Fatalf("re-saving must not fail: %v", err)
	}
	if second[testRollID].(map[string]any)["value"] != 11 {
		t.Error("a re-save must preserve the stored result")
	}
}
