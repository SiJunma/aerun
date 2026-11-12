package forum_test

import (
	"strings"
	"testing"

	"github.com/SiJunma/aerun/backend/internal/forum"
)

func TestValidateTopicTitle(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantErr error
		want    string
	}{
		{
			name:    "valid title",
			input:   " Hello World ",
			wantErr: nil,
			want:    "Hello World",
		},
		{
			name:    "empty title",
			input:   "   ",
			wantErr: forum.ErrTopicTitleRequired,
		},
		{
			name:    "too long title",
			input:   strings.Repeat("a", forum.MaxTopicTitleLen+1),
			wantErr: forum.ErrTopicTitleTooLong,
		},
		{
			name:    "CRLF title is refused (SEC-07 header injection)",
			input:   "Hello\r\nX-Injected: yes",
			wantErr: forum.ErrTopicTitleCRLF,
		},
		{
			name:    "bare LF title is refused (SEC-07 header injection)",
			input:   "Hello\nworld",
			wantErr: forum.ErrTopicTitleCRLF,
		},
		{
			name:    "leading newline is trimmed away, not an error",
			input:   "\nHello World",
			wantErr: nil,
			want:    "Hello World",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := forum.ValidateTopicTitle(tc.input)
			if err != tc.wantErr {
				t.Fatalf("expected error %v, got %v", tc.wantErr, err)
			}
			if tc.wantErr == nil && got != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, got)
			}
		})
	}
}

// TestValidateGuestNicknameCRLF pins SEC-07 for the guest nickname, which
// reaches the DM subject exactly like a topic title reaches its template.
func TestValidateGuestNicknameCRLF(t *testing.T) {
	for _, input := range []string{"Nickname\r\nX-Injected: 1", "Nick\nname", "A\rB"} {
		if _, err := forum.ValidateGuestNickname(input); err != forum.ErrGuestNicknameCRLF {
			t.Fatalf("expected ErrGuestNicknameCRLF for %q, got %v", input, err)
		}
	}
	if got, err := forum.ValidateGuestNickname("Regular Nick"); err != nil || got != "Regular Nick" {
		t.Fatalf("a clean nickname must pass, got %q / %v", got, err)
	}
}

func TestValidatePostContent(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantErr error
		want    string
	}{
		{
			name:    "valid content",
			input:   " Some post text ",
			wantErr: nil,
			want:    "Some post text",
		},
		{
			name:    "empty content",
			input:   " \n\t ",
			wantErr: forum.ErrPostContentRequired,
		},
		{
			name:    "too long content",
			input:   strings.Repeat("x", forum.MaxPostContentLen+1),
			wantErr: forum.ErrPostContentTooLong,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := forum.ValidatePostContent(tc.input)
			if err != tc.wantErr {
				t.Fatalf("expected error %v, got %v", tc.wantErr, err)
			}
			if tc.wantErr == nil && got != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, got)
			}
		})
	}
}

func TestClampLimit(t *testing.T) {
	if got := forum.ClampLimit(0, 20); got != 20 {
		t.Fatalf("expected 20, got %d", got)
	}
	if got := forum.ClampLimit(-5, 10); got != 10 {
		t.Fatalf("expected 10, got %d", got)
	}
	if got := forum.ClampLimit(500, 20); got != forum.MaxPageLimit {
		t.Fatalf("expected %d, got %d", forum.MaxPageLimit, got)
	}
	if got := forum.ClampLimit(15, 20); got != 15 {
		t.Fatalf("expected 15, got %d", got)
	}
}

func TestValidateReputationVote(t *testing.T) {
	cases := []struct {
		name        string
		voterID     string
		targetID    string
		value       int
		comment     string
		wantErr     error
		wantVal     int
		wantComment string
	}{
		{
			name:        "valid upvote",
			voterID:     "voter1",
			targetID:    "target1",
			value:       1,
			comment:     "Great job!",
			wantErr:     nil,
			wantVal:     1,
			wantComment: "Great job!",
		},
		{
			name:        "valid downvote",
			voterID:     "voter1",
			targetID:    "target1",
			value:       -1,
			comment:     "",
			wantErr:     nil,
			wantVal:     -1,
			wantComment: "",
		},
		{
			name:     "self vote prohibited",
			voterID:  "user1",
			targetID: "user1",
			value:    1,
			comment:  "",
			wantErr:  forum.ErrReputationSelfVote,
		},
		{
			name:     "invalid value zero",
			voterID:  "voter1",
			targetID: "target1",
			value:    0,
			comment:  "",
			wantErr:  forum.ErrReputationInvalidValue,
		},
		{
			name:     "invalid value large",
			voterID:  "voter1",
			targetID: "target1",
			value:    5,
			comment:  "",
			wantErr:  forum.ErrReputationInvalidValue,
		},
		{
			name:     "missing voter",
			voterID:  "",
			targetID: "target1",
			value:    1,
			comment:  "",
			wantErr:  forum.ErrReputationVoterOrTargetRequired,
		},
		{
			name:     "missing target",
			voterID:  "voter1",
			targetID: "",
			value:    1,
			comment:  "",
			wantErr:  forum.ErrReputationVoterOrTargetRequired,
		},
		{
			name:     "comment too long",
			voterID:  "voter1",
			targetID: "target1",
			value:    1,
			comment:  strings.Repeat("a", 1025),
			wantErr:  forum.ErrReputationCommentTooLong,
		},
		{
			name:        "comment trimmed",
			voterID:     "voter1",
			targetID:    "target1",
			value:       1,
			comment:     "  nice comment  ",
			wantErr:     nil,
			wantVal:     1,
			wantComment: "nice comment",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			val, comment, err := forum.ValidateReputationVote(tc.voterID, tc.targetID, tc.value, tc.comment)
			if err != tc.wantErr {
				t.Fatalf("expected error %v, got %v", tc.wantErr, err)
			}
			if err == nil {
				if val != tc.wantVal {
					t.Fatalf("expected val %d, got %d", tc.wantVal, val)
				}
				if comment != tc.wantComment {
					t.Fatalf("expected comment %q, got %q", tc.wantComment, comment)
				}
			}
		})
	}
}
