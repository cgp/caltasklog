# Dayplot

Dayplot is a self-contained, browser-based project planner. A plain-text plan is parsed into six views: Edit, Today, Timeline, Calendar, Groups, and Tasks. The application lives entirely in `index.html`; it has no external runtime dependencies and saves the current plan in browser-local storage.

## Defining schedules and events

This section is the most important part of the document. Dayplot treats each nonblank, noncomment line as either a schedule declaration or a task/event definition.

### Recommended complete example

```text
! Offseason - Aug 7, 2026 - Jan 5
? - Kettering
    Aug 7-10 - Shooter Move (CAD) [Blocked - needs part]
        Another thing - [Done]
        Aug 7 - Chassis Design
    Aug 10-20 - Spindexer POC (Akylas) [In Progress - almost done] #0b5ea8 {{https://example.com/spindexer}}
    Sep 13 - Kettering Kickoff
Sep 3 - Parent Meeting #f00
Aug 25 - AI Meeting

! Build Season
Jan 5 - Kickoff
Mar 10 - Competition
```

### Canonical grammar

Use this ordering when generating or editing Dayplot plans:

```text
! Schedule name - Start date - End date

Date or date range - Task name (Resource, Resource) [Status - note] #color {{https://link}}
```

All metadata after the task name is optional. The canonical task detail order is:

1. Task name
2. Resources in parentheses
3. Status and optional note in square brackets
4. Color as a hexadecimal value
5. Link in braces, always last

In compact form, square brackets below mean an optional grammar component; literal square brackets used for status are shown inside quotes:

```text
task-line    := indentation task-prefix " - " task-detail
task-prefix  := date-or-range | "?" | integer " day" | integer " days"
task-detail  := name [resources] [status-block] [color] [link]
resources    := "(" resource ["," resource ...] ")"
status-block := "[" status [" - " note] "]"
color        := "#" followed by 3, 6, or 8 hexadecimal digits
link         := "{{" HTTP-or-HTTPS-URL "}}"
```

The parser tolerates some metadata in a different order, but users and code generators should emit the canonical order above. Keeping the link last is required.

### Line types at a glance

| Line type | Form | Example | Primary meaning |
|---|---|---|---|
| Named schedule | `! name - start - end` | `! Offseason - Aug 7, 2026 - Jan 5` | Starts a schedule section and optionally defines its range |
| Dated task | `date-or-range - detail` | `Aug 7-10 - Shooter Move (CAD)` | Work occupying an inclusive calendar range |
| Derived summary | `? - detail` | `? - Kettering` | Structural parent whose dates come from descendants |
| Relative duration | `N days - detail` | `5 days - Fabricate brackets` | Work positioned relative to a dated peer or parent |
| Undated task | `detail` | `Chassis Electrical Moved` | Tracked work with no calendar commitment |
| Undated task with status | `name - [status - note]` | `Another thing - [Done]` | Undated work carrying workflow state |
| Comment | `# text` | `# Waiting for final dates` | Ignored by parsing and all derived views |

### Schedule declarations

A named schedule begins with `!` at the start of a line.

```text
! Offseason - Aug 7, 2026 - Jan 5
! Build Season
```

- A declaration starts a new schedule section. Following task lines belong to that schedule until the next `!` declaration.
- A schedule may provide both a start and end date or omit both dates.
- If an explicit range is supplied, it controls date inference and the visible range for that schedule.
- If only one endpoint contains a year, Dayplot infers the other year. In the Offseason example, `Jan 5` becomes January 5, 2027 because it follows August 7, 2026.
- If both endpoints omit their years, Dayplot infers the start year from the current one-year inference window and rolls the end into the following year when the month/day sequence crosses New Year.
- If the schedule omits its range, Dayplot derives it from the earliest and latest dated tasks, adding one day before and one day after.
- A schedule containing only undated tasks has no meaningful chart range. Internally, Dayplot uses a small range around today so the document remains renderable; the Tasks view is the useful view for that schedule.
- Tasks entirely outside an explicit schedule range are reported as errors.

If the document contains tasks but no `!` declarations, Dayplot creates one implicit default schedule. The schedule selector is hidden in that case.

### Dated tasks and events

A dated task starts with one date or a date range, followed by a spaced hyphen and the task detail.

```text
Aug 10 - Single-day task
Aug 10-12 - Same-month range
Aug 10-Aug 20 - Explicit same-year range
Dec 5-Jan 8 - Range crossing months or years
Aug 10, 2026-Aug 20, 2026 - Fully explicit range
```

Important date rules:

- Month names are case-insensitive. Standard short or full English month names are accepted.
- `Sep`, `Sept`, and `September` are accepted. The legacy typo `Set` is also recognized, but should not be generated.
- Years are optional.
- A one-date task has the same start and end date.
- In a same-month shorthand such as `Aug 10-12`, the month and any explicit start year are copied to the end date.
- When an inferred end date would be before its start and the end has no explicit year, the end is moved to the following year.
- Dates are inclusive. `Aug 10-12` occupies three days.
- Use spaces around the hyphen that separates the date expression from the task name: `Aug 10-12 - Task`.

Yearless task dates are resolved inside the containing schedule range. Without an explicit schedule range, they are initially resolved within a window from today through the same date next year; the derived schedule range is then calculated from the resolved tasks.

### Derived summary parents

Use `?` when a parent should derive its dates from its dated descendants.

```text
? - Kettering
    Aug 7-10 - Shooter Move
    Sep 13 - Kettering Kickoff
```

- A summary parent starts undated.
- After all lines are parsed, its start becomes the earliest dated descendant start and its end becomes the latest dated descendant end.
- All descendant levels are considered, not only direct children.
- A summary with no dated descendants remains undated.
- Derived summaries appear in Timeline and Tasks when dates can be derived. A root summary also becomes a Calendar parent container; nested summaries are generally represented through their deepest dated descendants there.
- Summary parents are deliberately excluded from Today because they represent structure rather than direct work.

### Duration-relative tasks

A duration task uses a number of days in place of a date.

```text
5 days - Fabricate brackets
```

- Its duration is inclusive: a five-day task receives five calendar days.
- It starts one day after the previous dated task at the same indentation depth.
- If there is no prior same-depth dated task, it uses its dated parent's start.
- A duration task should therefore follow a dated peer or be nested under a dated parent. Do not use an unanchored duration as the first root task.

### Undated tasks

Undated tasks are valid and are useful for tracking steps that have no calendar commitment.

```text
Chassis Electrical Moved
Another thing - [Done]
Research alternate motor [In Progress - waiting on vendor]
```

- A plain unmatched line becomes an undated task.
- The `Task name - [Status]` form is accepted for readability; the separator is not part of the task name.
- Undated tasks always appear in Tasks.
- They do not appear in Timeline, Calendar, or Groups because those views require dates.
- They appear in Today only when their status explicitly indicates active work, such as In Progress, Active, Blocked, Stuck, or Review.

### Hierarchy and indentation

Indentation defines parent/child relationships.

```text
? - Parent
    Aug 7-10 - Child
        Aug 7 - Grandchild
```

- One tab is treated as four spaces.
- Four additional spaces create one deeper level.
- Indentation may not jump more than one level at a time.
- The smallest common indentation within each schedule is treated as the section baseline. This allows all tasks under a schedule heading to share a small common indent without becoming children.
- The closest preceding task one level above becomes the parent.
- Parenthood is structural and independent of whether the parent has explicit or derived dates.

### Resources or assignees

Resources are comma-separated names in trailing parentheses.

```text
Aug 10-12 - Shooter Move (CAD)
Aug 10-12 - Field Assembly (Mechanical, Electrical)
```

- Resources are stored as a list after trimming whitespace.
- Tasks with multiple resources may be repeated in multiple resource/group lanes.
- The Tasks view shows only resources explicitly written on that task.
- Today inherits resources from the nearest ancestor when a task has no explicit resource. If no ancestor supplies one, the task is placed in `Unassigned`.
- The Groups view currently does not inherit ancestor resources; a task without an explicit resource appears in `Unassigned` there.

### Status and note

Status metadata uses square brackets. A hyphen inside the brackets separates status from note at the first hyphen.

```text
[Done]
[Blocked - needs part]
[In Progress - almost done]
```

Status comparisons are case-insensitive.

- Done states: `Done`, `Complete`, or `Completed`.
- Explicitly active states contain or equal: `Progress`, `Active`, `Block`, `Stuck`, or `Review`.
- Done rows use the completed style.
- In Progress and Active use the progress style.
- Blocked and Stuck use the blocked style.
- Review uses the review style.
- Other nonempty statuses are displayed using the neutral status style.

A parent marked Done while any descendant is not Done produces a non-blocking warning in Edit. The warning identifies the parent's source line and counts its unfinished descendants. The plan still renders.

### Links

Place an HTTP or HTTPS URL at the end of the task detail inside braces. Double braces are the recommended form.

```text
Aug 10-20 - Spindexer POC {{https://example.com/task}}
Aug 10-20 - Spindexer POC - {{https://example.com/task}}
```

- The link must be the final metadata item.
- Single braces are accepted, but double braces are canonical.
- A legacy bare URL preceded by ` - ` is also recognized.
- Linked task titles are visibly underlined and open in a new tab.
- Timeline task labels and Groups bars/milestones are linkable when a task has a link.

### Colors and comments

A trailing hexadecimal color controls the task's rendered color.

```text
Sep 3 - Parent Meeting #f00
Sep 3 - Parent Meeting #ff0000
Sep 3 - Parent Meeting #ff000080
```

- Three-, six-, and eight-digit hexadecimal colors are valid.
- A missing color defaults to dark blue for structural parents.
- Other uncolored tasks rotate through blue, red, and yellow according to source order.
- A line whose first non-whitespace character is `#` is a comment and is ignored completely.
- Therefore, `#` at the start of a line means comment; `#hex` at the end of a task means color.

```text
# This is a comment
Aug 25 - AI Meeting #0b5ea8
```

## View construction and filtering

All views operate on the currently selected schedules. Selecting multiple schedules concatenates their tasks, preserves hierarchy within each schedule, and uses the earliest selected start and latest selected end as the merged range. At least one named schedule must remain selected.

Parse errors block chart/table rendering and send the user back to Edit. Hierarchy consistency warnings do not block rendering.

### Edit

Edit is the source-of-truth text editor.

- The editor uses a normal textarea with a synchronized presentation layer for syntax coloring.
- Syntax colors distinguish schedule markers, dates, durations, parent markers, resources, statuses, links, color codes, separators, and comments.
- Typing updates the item count, syntax coloring, schedule list, and hierarchy warnings.
- Blank lines, comments, and schedule declarations are excluded from the item count.
- The text is saved to browser-local storage after a short debounce. The existing storage key intentionally remains `planline-data` so the Dayplot rename does not discard previously saved plans.
- Storage is device/browser-local; there is no server synchronization.

### Today

Today answers: "What should each resource be working on now?"

Candidate tasks are filtered as follows:

1. Exclude derived `?` summary tasks.
2. Exclude tasks whose status is Done, Complete, or Completed.
3. Include a task when at least one of these is true:
   - Today falls inclusively between its start and end dates.
   - Its end date is before today, making it overdue and unfinished.
   - Its status explicitly indicates active work: In Progress, Active, Blocked, Stuck, or Review. This status rule overrides future dates and also allows active undated tasks.

After filtering:

- Each task uses its own explicit resources, or inherits the nearest ancestor's resources, or falls into `Unassigned`.
- A multi-resource task appears in every applicable resource lane.
- Resource lanes are sorted alphabetically, with `Unassigned` last.
- Tasks remain in source order inside each lane.
- Parent/child styling is lane-local. A row is styled as a parent and a child is indented only when both active rows have a direct structural relationship and appear in the same resource lane.
- If a parent and child belong to different resources, each is flat in its own lane.
- If a parent is filtered out, its visible descendants are flat unless another displayed direct parent exists in that lane.
- The columns are identical to Tasks: Task, Assignee, Status, Note, Start date, End date, and Timing.

### Timeline

Timeline is the continuous Gantt view.

- It includes every selected task with both a start and end date: dated tasks, resolved duration tasks, and derived summary parents.
- Undated tasks are omitted.
- Rows remain in merged source order and retain indentation.
- The horizontal scale is fixed at 30 pixels per calendar day.
- The header shows months, dates, and weekday initials.
- Weekends are shaded and the current day is marked when it falls inside the selected range.
- Ordinary ranges render as solid bars.
- Single-day leaf tasks render as diamond milestones.
- Any task with children renders using the compact parent/summary line style.
- Bars are clipped to the merged selected range.
- Linked task labels are clickable.

### Calendar

Calendar is a dense month-per-row representation.

- Every month in the selected overall range receives one stacked section.
- Every day has the same width across every month, based on a 31-day row.
- A 31-day month fills the available date width. A 30-day or February row ends after its final day and leaves blank space on the right.
- Month rows repeat date numbers and weekday initials. Weekends are shaded.
- Only root tasks receive named rows.
- A root task with no children renders as a solid range line or a single-day milestone.
- A root task with children renders as a translucent outlined parent container.
- Inside a parent container, Dayplot renders the deepest dated descendants: a dated descendant is omitted when it has another dated descendant below it.
- Overlapping descendant date ranges are packed into separate eight-pixel lanes. Ranges that share a date are considered overlapping.
- Parent rows expand vertically to fit all overlap lanes.
- Tasks are clipped to each month. A parent continuing from the prior month has an open left edge; one continuing into the next month has an open right edge.
- Undated roots and descendants are omitted.

### Groups

Groups is a resource-oriented Gantt view across the full continuous schedule.

- Only scheduled leaf-most work is shown. A dated task is excluded when it has another dated descendant, preventing parent and child bars from duplicating the same work.
- Resources come only from the task's own parentheses in this view; they are not inherited.
- Tasks with no explicit resource appear under `Unassigned`.
- Tasks with multiple resources appear in every named group.
- Groups are alphabetical, with `Unassigned` last.
- Tasks within a group are ordered by start date and then end date.
- The time scale, month/day header, weekend grid, and today marker match Timeline.
- Single-day tasks use milestones; longer tasks use bars.
- Linked labels and plotted marks are clickable.

### Tasks

Tasks is the complete inventory and is the only unfiltered task view.

- Every parsed task appears, including dated, duration, summary, and undated tasks.
- Rows remain in source order.
- Indentation mirrors the source hierarchy.
- Rows with children receive parent styling.
- Linked titles are clickable.
- Columns are Task, Assignee, Status, Note, Start date, End date, and Timing.
- Dates omit the year when they fall in the current calendar year; other years are displayed.

Timing is calculated as follows:

- Undated: `—`
- Future single-day task: number of days until
- Single-day task today: `Today`
- Past single-day task: number of days past
- Future multi-day task: total inclusive duration
- Active multi-day task: number of days left until its inclusive end
- Past multi-day task: number of days past its end

## Inclusion summary

| Task kind | Edit | Today | Timeline | Calendar | Groups | Tasks |
|---|---:|---:|---:|---:|---:|---:|
| Dated task | Source | Active, overdue, or active status; not Done | Yes | Yes, subject to root/deepest-descendant rules | Leaf-most dated work | Yes |
| Derived `?` summary | Source | No | If dates derive | If root and dates derive | No when it has dated descendants | Yes |
| Duration task | Source | After resolution, same Today rules | If resolved | If resolved and selected by hierarchy rules | If resolved and leaf-most | Yes |
| Undated task | Source | Only with explicit active status | No | No | No | Yes |
| Done task | Source | No | Yes when dated | Yes when dated | Yes when dated and leaf-most | Yes |
| Comment | Source only | No | No | No | No | No |

## Implementation notes

- The application is a single HTML file with embedded CSS and JavaScript.
- Dates use the browser's local timezone and calendar.
- Day differences are calculated in whole calendar-day increments.
- Rendering is regenerated from the editor text; the parsed task list is not independently editable.
- Schedule selection changes every derived view but not the source text.
- When changing parsing or filtering logic, update this README and add a regression fixture that covers the affected syntax and view.
