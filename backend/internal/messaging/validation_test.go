package messaging

import (
	"strings"
	"testing"
)

func TestValidateMessageText(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantErr error
		want    string
	}{
		{
			name:    "valid text",
			input:   "Hello world!",
			wantErr: nil,
			want:    "Hello world!",
		},
		{
			name:    "trimmed spaces",
			input:   "  Leading and trailing   ",
			wantErr: nil,
			want:    "Leading and trailing",
		},
		{
			name:    "empty string",
			input:   "",
			wantErr: ErrMessageTextRequired,
		},
		{
			name:    "whitespace only",
			input:   "    \t\n   ",
			wantErr: ErrMessageTextRequired,
		},
		{
			name:    "too long text",
			input:   strings.Repeat("a", MaxDMMessageLen+1),
			wantErr: ErrMessageTextTooLong,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ValidateMessageText(tc.input)
			if err != tc.wantErr {
				t.Fatalf("expected error %v, got %v", tc.wantErr, err)
			}
			if got != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, got)
			}
		})
	}
}

func TestValidateParticipants(t *testing.T) {
	sender := "user_sender"

	// No recipients
	_, err := ValidateParticipants(sender, []string{})
	if err != ErrNoRecipients {
		t.Fatalf("expected ErrNoRecipients, got %v", err)
	}

	// Only sender as recipient
	_, err = ValidateParticipants(sender, []string{sender, "  "})
	if err != ErrNoRecipients {
		t.Fatalf("expected ErrNoRecipients, got %v", err)
	}

	// Valid recipients with duplicates
	recipients, err := ValidateParticipants(sender, []string{"user_b", "user_a", "user_b", "  user_c  ", sender})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	expected := []string{"user_a", "user_b", "user_c"}
	if len(recipients) != len(expected) {
		t.Fatalf("expected %d recipients, got %d", len(expected), len(recipients))
	}
	for i, r := range recipients {
		if r != expected[i] {
			t.Fatalf("expected recipient %s at index %d, got %s", expected[i], i, r)
		}
	}
}

func TestMakeDMUnreadDedupeKey(t *testing.T) {
	key := MakeDMUnreadDedupeKey("conv123", "user456")
	expected := "dm:first-unread:conv123:user456"
	if key != expected {
		t.Fatalf("expected dedupe key %q, got %q", expected, key)
	}
}

func TestClampLimit(t *testing.T) {
	if got := ClampLimit(0, 20); got != 20 {
		t.Fatalf("expected fallback 20, got %d", got)
	}
	if got := ClampLimit(-5, 20); got != 20 {
		t.Fatalf("expected fallback 20, got %d", got)
	}
	if got := ClampLimit(150, 20); got != MaxPageLimit {
		t.Fatalf("expected %d, got %d", MaxPageLimit, got)
	}
	if got := ClampLimit(15, 20); got != 15 {
		t.Fatalf("expected 15, got %d", got)
	}
}
