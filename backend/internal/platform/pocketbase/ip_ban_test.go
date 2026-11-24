package pocketbase

import (
	"encoding/hex"
	"net"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// ParseIPRange
// ---------------------------------------------------------------------------

func TestParseIPRange_SingleIPv4(t *testing.T) {
	start, end, err := ParseIPRange("1.2.3.4")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if start != end {
		t.Errorf("single IP: start %q != end %q", start, end)
	}
	// 1.2.3.4 as IPv4-mapped IPv6 → 00000000000000000000ffff01020304
	ip := net.ParseIP("1.2.3.4").To16()
	want := hex.EncodeToString(ip)
	if start != want {
		t.Errorf("start = %q, want %q", start, want)
	}
}

func TestParseIPRange_SingleIPv6(t *testing.T) {
	start, end, err := ParseIPRange("2001:db8::1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if start != end {
		t.Errorf("single IPv6: start %q != end %q", start, end)
	}
}

func TestParseIPRange_CIDRv4(t *testing.T) {
	start, end, err := ParseIPRange("192.168.1.0/24")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if start == end {
		t.Errorf("CIDR /24 should produce a range, not equal hex values")
	}
	// start must be .0, end must be .255
	wantStart := hex.EncodeToString(net.ParseIP("192.168.1.0").To16())
	wantEnd := hex.EncodeToString(net.ParseIP("192.168.1.255").To16())
	if start != wantStart {
		t.Errorf("CIDR start = %q, want %q", start, wantStart)
	}
	if end != wantEnd {
		t.Errorf("CIDR end = %q, want %q", end, wantEnd)
	}
}

func TestParseIPRange_CIDRv4_32(t *testing.T) {
	// /32 — single host, start == end
	start, end, err := ParseIPRange("10.0.0.1/32")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if start != end {
		t.Errorf("/32 CIDR: start %q != end %q", start, end)
	}
}

func TestParseIPRange_Empty(t *testing.T) {
	_, _, err := ParseIPRange("")
	if err == nil {
		t.Error("expected error for empty string, got nil")
	}
}

func TestParseIPRange_InvalidCIDR(t *testing.T) {
	_, _, err := ParseIPRange("999.999.999.999/24")
	if err == nil {
		t.Error("expected error for invalid CIDR")
	}
}

func TestParseIPRange_InvalidIP(t *testing.T) {
	_, _, err := ParseIPRange("not-an-ip")
	if err == nil {
		t.Error("expected error for non-IP string")
	}
}

// ---------------------------------------------------------------------------
// IsSafeListedIP
// ---------------------------------------------------------------------------

func TestIsSafeListedIP_Loopback(t *testing.T) {
	cases := []string{"127.0.0.1", "::1", "127.255.255.255"}
	for _, ip := range cases {
		if !IsSafeListedIP(ip) {
			t.Errorf("expected %q to be safe-listed (loopback)", ip)
		}
	}
}

func TestIsSafeListedIP_Unspecified(t *testing.T) {
	if !IsSafeListedIP("0.0.0.0") {
		t.Error("expected 0.0.0.0 to be safe-listed (unspecified)")
	}
	if !IsSafeListedIP("::") {
		t.Error("expected :: to be safe-listed (unspecified)")
	}
}

func TestIsSafeListedIP_Public(t *testing.T) {
	cases := []string{"8.8.8.8", "192.168.1.1", "10.0.0.1", "2001:db8::1"}
	for _, ip := range cases {
		if IsSafeListedIP(ip) {
			t.Errorf("expected %q NOT to be safe-listed", ip)
		}
	}
}

func TestIsSafeListedIP_Invalid(t *testing.T) {
	if IsSafeListedIP("not-an-ip") {
		t.Error("invalid IP string should not be safe-listed")
	}
	if IsSafeListedIP("") {
		t.Error("empty string should not be safe-listed")
	}
}

func TestIsSafeListedRange(t *testing.T) {
	// Catch-all and loopback ranges must be rejected
	dangerous := []string{"0.0.0.0/0", "127.0.0.0/8", "::/0"}
	for _, cidr := range dangerous {
		s, e, err := ParseIPRange(cidr)
		if err != nil {
			t.Fatalf("ParseIPRange(%q): %v", cidr, err)
		}
		if !IsSafeListedRange(s, e) {
			t.Errorf("expected %q range to be flagged as protected/safelisted", cidr)
		}
	}

	// Normal public range is allowed to be banned
	s, e, err := ParseIPRange("198.51.100.0/24")
	if err != nil {
		t.Fatalf("ParseIPRange: %v", err)
	}
	if IsSafeListedRange(s, e) {
		t.Error("public range 198.51.100.0/24 should not be flagged as safelisted")
	}
}

// ---------------------------------------------------------------------------
// IPToHex / IPToNormalized16 helpers
// ---------------------------------------------------------------------------

func TestIPToHex_IPv4(t *testing.T) {
	ip := net.ParseIP("0.0.0.1")
	h := IPToHex(ip)
	if !strings.HasSuffix(h, "00000001") {
		t.Errorf("IPToHex(0.0.0.1) = %q, want suffix 00000001", h)
	}
	if len(h) != 32 {
		t.Errorf("hex length = %d, want 32", len(h))
	}
}

func TestIPToHex_Nil(t *testing.T) {
	if IPToHex(nil) != "" {
		t.Error("IPToHex(nil) should return empty string")
	}
}

// ---------------------------------------------------------------------------
// CheckIPBanned — without a live DB we test the pure IP-matching math.
// We build a ban entry manually and verify the hex-range comparison logic.
// ---------------------------------------------------------------------------

func hexContainsIP(startHex, endHex, ipStr string) bool {
	ip := net.ParseIP(strings.TrimSpace(ipStr))
	if ip == nil {
		return false
	}
	h := IPToHex(ip)
	return h >= startHex && h <= endHex
}

func TestCheckIPBanned_InRange(t *testing.T) {
	start, end, err := ParseIPRange("192.168.1.0/24")
	if err != nil {
		t.Fatalf("ParseIPRange: %v", err)
	}
	// IPs inside /24
	inside := []string{"192.168.1.1", "192.168.1.100", "192.168.1.255"}
	for _, ip := range inside {
		if !hexContainsIP(start, end, ip) {
			t.Errorf("expected %q to be in range %q..%q", ip, start, end)
		}
	}
	// IPs outside /24
	outside := []string{"192.168.2.1", "10.0.0.1", "8.8.8.8"}
	for _, ip := range outside {
		if hexContainsIP(start, end, ip) {
			t.Errorf("expected %q NOT to be in range %q..%q", ip, start, end)
		}
	}
}

func TestCheckIPBanned_SingleIP(t *testing.T) {
	start, end, err := ParseIPRange("5.5.5.5")
	if err != nil {
		t.Fatalf("ParseIPRange: %v", err)
	}
	if !hexContainsIP(start, end, "5.5.5.5") {
		t.Error("5.5.5.5 should match its own ban entry")
	}
	if hexContainsIP(start, end, "5.5.5.6") {
		t.Error("5.5.5.6 should not match a ban for 5.5.5.5")
	}
}
