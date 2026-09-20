package auth

import "slices"

// DefaultPermissions returns the default permission set of a role while the
// account status is active. Unknown roles (including the legacy pseudo-roles
// "pending"/"banned", which must not appear in the role column) deny
// everything — deny-by-default.
func DefaultPermissions(role Role) []Permission {
	spec, ok := SpecFor(role)
	if !ok {
		return []Permission{}
	}
	return slices.Clone(spec.Permissions)
}

// EffectivePermissions resolves the compiled default matrix for a role and
// status. It is the static fallback used when the roles collection has no
// matching row, and the reference for reconciliation tests.
//
// The bool result reports whether the role is known; callers must treat an
// unknown role as "no permissions" regardless of the returned slice.
func EffectivePermissions(role Role, status Status) ([]Permission, bool) {
	spec, ok := SpecFor(role)
	if !ok {
		return []Permission{}, false
	}
	return NarrowForStatus(spec.Permissions, status), true
}
