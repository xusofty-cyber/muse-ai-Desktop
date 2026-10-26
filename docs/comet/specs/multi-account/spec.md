# multi-account Specification

## Requirements

### Requirement: Multi-Account Session Isolation & Scalable Dock Navigation
The system SHALL support managing and switching between at least 12 user accounts (unlimited), each isolated using Electron session partitions (`persist:muse-${profileId}`), and presented via a non-squeezing, responsive dock.

#### Scenario: Switching accounts
- **WHEN** the user clicks an account avatar in the dock or uses the global hotkey
- **THEN** the system switches to that account session partition and smoothly reveals the active window

#### Scenario: Adding accounts
- **WHEN** the user clicks the add account button (`+`)
- **THEN** the system creates a new account profile and switches to it for fresh login

#### Scenario: Renaming accounts
- **WHEN** the user renames an existing account
- **THEN** the system persists the custom name and updates the dock, tooltip, and tray menu

#### Scenario: Signing out of single account
- **WHEN** the user signs out of a specific account
- **THEN** the system clears that account's session storage without affecting any other account sessions

#### Scenario: Deleting account
- **WHEN** the user deletes a non-active account
- **THEN** the system removes the profile while preserving at least one remaining account

#### Scenario: Non-squeezing 12+ accounts dock list
- **WHEN** 9, 12, or more accounts are added to the system
- **THEN** the avatar items maintain their standard dimensions without vertical squashing or crowding, providing a slim translucent scrollbar when content exceeds viewport max-height

#### Scenario: Auto-collapsing dock on mouse leave
- **WHEN** the dock is in unpinned mode and the user hovers, switches an account, or finishes interacting
- **THEN** upon the mouse leaving the dock area, the dock smoothly collapses to the screen edge

#### Scenario: Pinning dock to keep expanded
- **WHEN** the user clicks the pin button (📌) on the dock header
- **THEN** the dock remains persistently expanded and does not auto-collapse when the mouse leaves, until explicitly unpinned
