# AGENTS.md

## 0. Functional Map (Agent's Source of Truth)

Before making any changes, the agent should consult the corresponding functional block.

| Functional Block | Source of Truth | Keywords |
|------------------|-----------------|----------------------|
| **Authentication** | `docs/agent/auth.md` | Hashing, Proof, password |
| **Budget Engine** | `docs/agent/budget.md` | Limits, Balance, Progress |
| **Offline & Cache**| `docs/agent/offline.md` | Service Worker, Sync |
| **Goals System** | `docs/agent/goals.md` | Progress, Monthly Requirement |
| **Testing** | `docs/agent/test_scenarios.md`| Mocking, Sandbox, Scenarios |

Agents.md and docs/agent/ references are designed to optimize context usage and ensure consistency across AI interactions.

## 1. Introduction & General Rules
- **[README.md](README.md)** — User setup and instructions.
- **Context Rule**: Only describe what exists. No history, no deleted entities, no rejected options.
- **Language Rule**: Documentation and Code (comments, variables, functions) are in **English**. UI Text (buttons, labels, error messages, categories) is in **Ukrainian**.
- **Response Style**: Short and direct. Answer first, provide details only if requested.
- **Context Optimization**: AGENTS.md is a "map" for the agent. High-level rules, architecture, and glossary go here. Detailed technical logic, formulas, and test scenarios must stay in docs/agent/. README.md is for the human user (instructions) and remains in Ukrainian.
- **Documentation Updates**: All documentation (README, AGENTS.md, and docs/agent/ files) must be updated whenever new features are implemented or significant changes are made to ensure the "Source of Truth" remains accurate.
- **No Backward Compatibility**: Breaking changes are allowed and acceptable.
- **Strong Validation**: Ensure robust validation for all inputs, state transitions, and data types.
- **Operational Culture**: 
    - **Two people working**: The owner also writes code. Unfamiliar code might be a deliberate change, not a bug. Ask before "fixing."
    - **Speak up**: Report errors and out-of-scope changes immediately. Don't try to fix them silently.
    - **Ask, don't push**: Questions from the owner are for exploring options. Report possibilities and consequences, but don't push for a decision.
    - **Git is the owner's**: Do not change repository state (no commit, merge, checkout, branch, stash, reset, push, fetch). Read-only commands (`status`, `log`, `diff`, `show`, `blame`) are allowed only for review. Do not offer to commit or merge.
- **Coding Standards**:
    - **Comments**: Explain *why*, not *what*.
    - **Exports**: Every exported function *must* have a `@returns` tag.
- **Critical Tech Rules**:
    - **Fetch**: Always check `response.ok`. A 5xx error is a failed request, not a caught exception.
    - **Timezones**: Avoid `toISOString()` for local dates (it shifts to UTC). Use local getters (`getHours()`, etc.).
    - **Ownership**: New entities must have a defined owner (Login, Browser, or Dispatcher) before being added. This is the owner of the entity's *client-side lifecycle/storage scope* (e.g., the queue is Login-scoped), not data-level access control. Data-level authorship exists only for Transactions (each records who entered it). Goals are shared by all users: any logged-in user sees and adjusts every goal.

## 2. Architecture & Layers
The project follows a strict downward-only dependency hierarchy:
1. **ui/ (View Layer)**: Handles DOM, events, and UI state. Knows nothing about the network.
2. **core/ (Service Layer)**: Handles network requests, session management, and local storage wrappers. Knows nothing about the DOM.
3. **domain/ (Logic Layer)**: Pure logic. Handles dates, expressions, math, and entity formatting. Knows nothing about the network or DOM.
- `main.js` acts as the **Dispatcher**. It coordinates the flow between layers and holds the application lifecycle.

## 3. Domain Entities & Glossary
The following terms are the core entities of the system. They are translated to English for agent/code use, but the UI remains Ukrainian.

| English Entity | Ukrainian UI Name | Description |
|----------------|-------------------|------------|
| Transaction     | Операція        | A single record of spending or income. |
| BudgetSnapshot  | Знімок бюджету | A list of transactions for a specific month. |
| Goal             | Ціль           | A target for accumulation (Savings) or spending (Project). |
| Limit            | Ліміт          | The monthly spending cap for a category. |
| PendingEntry    | Запис у черзі   | A transaction waiting to be synced to the server. |
| AuthProof        | Доказ авторизації | A timestamped SHA-256 hash for secure login. |
| User             | Користувач      | A person with a login, color, and password. |

Refer to [docs/agent/models.md](docs/agent/models.md) for detailed Core Objects (Data Models).

## 4. Core Logic Modules
- **Authorization**: `SHA-256` hashing for passwords; timestamped `AuthProof` used to bypass CORS limitations. Login attempt limits (5) and lockouts (15 min).
- **Queue System**: Login-scoped persistent queue in `localStorage`. Entries wait for network availability and sync automatically.
- **Offline Shell**: Service Worker (`sw.js`), `moneyflow-shell-v1` cache. Network-first strategy with a 3-month history limit.
- **Budgeting**: Limits are pulled from a separate sheet linked by Category name. Calculations (Progress, Monthly Requirement) are server-side.
- **Snapshots**: Requested periods are filtered and returned. The `limitPeriod` (current open month) is always prioritized to keep snapshots small.

## 5. UI & UX Patterns
- **Form Handling**: Single form for both Add and Edit. Edit mode pre-fills fields without separate logic.
- **Confirmation**: Success states and status indicators remain for 15s to confirm sync.
- **Responsiveness**: Compact view (mobile) vs. Expanded view (desktop). Form behavior changes based on screen width.
- **Theme**: Multi-theme system (`classic` and `solid`). CSS is additive.

## 6. Deployment & Testing
- **Deployment Order**: Server/Apps Script first, then Client.
- **Testing**: Tests run without Node (via `new Function` checks and mocked fetch). Detailed scenarios are in [docs/agent/test_scenarios.md](docs/agent/test_scenarios.md).
- **Localhost**: Run on port 5501 for local dev to avoid conflicts with the owner's server.
