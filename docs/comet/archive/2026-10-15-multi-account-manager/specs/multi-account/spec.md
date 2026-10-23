# multi-account Specification

## Requirements

### Requirement: Multi-Account Session Isolation
The system SHALL support managing and switching between at least 8 user accounts, each isolated using Electron session partitions (`persist:muse-${profileId}`).

#### Scenario: Switching accounts
- **WHEN** the user clicks an account avatar in the dock or uses the global hotkey
- **THEN** the system switches to that account session partition and reloads the active window

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
