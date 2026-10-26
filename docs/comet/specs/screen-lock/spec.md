# screen-lock Specification

## Requirements

### Requirement: Cryptographic Password Protection & Rate Limiting
The system SHALL secure the lock screen password using salted cryptographic slow hashing (`crypto.scryptSync`) and enforce rate limiting against brute-force attacks.

#### Scenario: Setting initial password
- **WHEN** the user enables screen lock and provides a new password with confirmation
- **THEN** the system generates a 16-byte random salt, computes the `scrypt` hash (64-byte key), and persists `{ enabled: true, hash, salt }` in state without storing plaintext

#### Scenario: Changing existing password
- **WHEN** the user requests a password change
- **THEN** the system requires verification of the current password using constant-time comparison (`crypto.timingSafeEqual`), rejecting the update if incorrect

#### Scenario: Brute-force protection
- **WHEN** an incorrect password is submitted 5 consecutive times
- **THEN** the system temporarily locks input for 30 seconds, displaying a countdown timer and rejecting attempts during the lockout window

---

### Requirement: Manual and Hotkey Screen Locking
The system SHALL allow users to immediately lock the client manually through multiple entry points.

#### Scenario: Global hotkey trigger
- **WHEN** the user presses the lock screen global hotkey (default `CommandOrControl+Shift+L`)
- **THEN** the system immediately transitions to locked state and conceals all chat windows

#### Scenario: System tray menu trigger
- **WHEN** the user selects "🔒 锁定客户端" from the system tray menu
- **THEN** the system immediately locks the interface and displays the unlock modal

#### Scenario: Settings button trigger
- **WHEN** the user clicks "立即锁屏" in the Security settings panel
- **THEN** the system immediately locks the application

---

### Requirement: Inactivity and Idle Auto-Lock
The system SHALL automatically lock the application after a configured period of user inactivity.

#### Scenario: Inactivity threshold reached
- **WHEN** auto-lock is enabled and system/in-app idle time exceeds the configured duration (`idleMinutes`: 1, 5, 15, 30, or 60 min)
- **THEN** the system automatically transitions into locked state without user intervention

#### Scenario: Activity resets timer
- **WHEN** user interaction occurs before the threshold is reached
- **THEN** the inactivity timer resets, preventing premature lock

---

### Requirement: Session Concealment & Input Interception While Locked
The system SHALL strictly prevent visual leakage and access to session data while in the locked state without blocking interaction with other system applications.

#### Scenario: Window concealment
- **WHEN** the application is locked
- **THEN** all profile windows, main window, and quick chat window are hidden or occluded, and a dedicated lock screen window (`lock.html`) is displayed

#### Scenario: Non-topmost window behavior
- **WHEN** the lock screen window is displayed
- **THEN** it SHALL NOT be set as `alwaysOnTop`, allowing the user to switch to and interact with other external desktop applications freely

#### Scenario: Shortcut suppression
- **WHEN** the application is locked
- **THEN** hotkeys for switching accounts, toggling sites, opening quick chat, or accessing settings are blocked

#### Scenario: Unlocking
- **WHEN** the user inputs the correct password into the lock screen
- **THEN** the system closes the lock window, unblocks shortcuts, and restores visibility and focus to the active profile window

---

### Requirement: Security Settings UI
The system SHALL provide a dedicated Security & Lock settings card within the preferences window.

#### Scenario: Managing lock configuration
- **WHEN** the user navigates to the Security tab in `hotkeys.html`
- **THEN** the user can toggle password lock, set/modify passwords, toggle auto-lock, choose timeout durations, and view the current lock hotkey
