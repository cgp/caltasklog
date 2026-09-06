# CalTaskLog (CTL)

CalTaskLog is a static, browser-based project planner and meeting logger. A plain-text plan is parsed into seven views: Edit, Today, Gantt, Timeline, Calendar, Groups, and Tasks. The Today view also contains a dated Markdown meeting-log workspace. It has no external runtime dependencies. Workspaces save to an IndexedDB cache and can sync with an external WebDAV folder or open a read-only HTTPS plan/catalog. Storage services remain outside this project.

The workspace bar provides a searchable document library, connection settings, sync/conflict review, native ZIP backup/restore, and text, Markdown, CSV, and iCalendar import/export. See [Storage and data exchange](STORAGE.md) for the file format, connection requirements, supported conversions, and tests. Host `index.html`, `storage.js`, `transfer.js`, `workspace-ui.js`, `workspace.css`, and `favicon.svg` together on HTTPS or localhost.

## Defining schedules and events

This section is the most important part of the document. CalTaskLog treats each nonblank, noncomment line as either a schedule declaration or a task/event definition.

### Recommended complete example

```text
@timezone=America/New_York
! Offseason - Aug 7 - Jan 5
:Kettering
    Aug 7-10: Shooter Move (CAD) [Blocked - needs part]
        :Another thing - [Done]
        Aug 7 2:30-3:30p: Chassis Design
    Aug 10-20: Spindexer POC (Akylas) [In Progress - almost done] #0b5ea8 {{https://example.com/spindexer}}
    Sep 13: Kettering Kickoff
Sep 3:Parent Meeting #f00
Aug 25,rrule=FREQ=WEEKLY;BYDAY=MO,WE,FR: AI Meeting

! Build Season - Jan 1 2027 - Apr 30
Jan 5: Kickoff
Mar 10: Competition
```

### Canonical grammar

Use this ordering when generating or editing CalTaskLog plans:

```text
@timezone=Area/City
! Schedule name (Default resource) - Start date - End date
!% Event schedule 2026

Date or date range[,rrule=RULE]: Task name (Resource, Resource) [Status - note] ^P1 #color {{https://link}}
%Date or date range: Event name [cancelled]
```

All metadata after the task name is optional. The canonical task detail order is:

1. Task name
2. Resources in parentheses
3. Status and optional note in square brackets
4. Priority as `^P0` through `^P4`
5. Color as a hexadecimal value
6. Link in braces, always last

In compact form, square brackets below mean an optional grammar component; literal square brackets used for status are shown inside quotes:

```text
item-line    := indentation ["%"] task-prefix ":" item-detail
task-prefix  := [date-or-range [time-range] | integer duration-unit] [",rrule=" rrule]
duration-unit := "day" | "days" | "week" | "weeks"
item-detail  := name [resources] [status-block] [priority] [color] [link]
resources    := "(" resource ["," resource ...] ")"
status-block := "[" status [" - " note] "]"
priority     := "^P0" | "^P1" | "^P2" | "^P3" | "^P4"
color        := "#" followed by 3, 6, or 8 hexadecimal digits
link         := "{{" HTTP-or-HTTPS-URL "}}"
```

The parser tolerates some metadata in a different order, but users and code generators should emit the canonical order above. Keeping the link last is required.

### Line types at a glance

| Line type | Form | Example | Primary meaning |
|---|---|---|---|
| Calendar timezone | `@timezone=Area/City` | `@timezone=America/New_York` | Sets the timezone for current-date behavior across the document |
| Named schedule | `! name - start - end` | `! Offseason - Aug 7, 2026 - Jan 5` | Starts a schedule section and optionally defines its range |
| Schedule resource | `! name (resource) year` | `! Website Launch (Bob) 2026` | Supplies a default resource to items without one |
| Year-anchored schedule | `! name year` | `! Tasks 2026` | Anchors yearless items while deriving the displayed range from them |
| Event schedule | `!% name year` or `!% name - start - end` | `!% Holidays 2026` | Marks every item in the section as an event |
| Individual event | `%date-or-range: detail` | `%Aug 20: Party` | Adds a planning event to a normal task schedule |
| Dated task | `date-or-range: detail` | `Aug 7-10: Shooter Move (CAD)` | Work occupying an inclusive calendar range |
| Timed task | `date time-time: detail` | `Aug 7 2:30-3:30p: Chassis Design` | Stores optional wall-clock time on a single date |
| Repeating task | `date,rrule=RULE: detail` | `Aug 25,rrule=FREQ=WEEKLY;BYDAY=MO,WE,FR: AI Meeting` | Expands a dated task using iCalendar recurrence fields |
| Derived summary | `:detail` with children | `:Kettering` | Structural parent whose dates come from descendants |
| Relative duration | `N days: detail` or `N weeks: detail` | `2 weeks: Fabricate brackets` | Work positioned relative to a dated peer or parent |
| Undated task | `:detail` | `:Chassis Electrical Moved` | Tracked work with no calendar commitment |
| Undated task with status | `:name [status - note]` | `:Another thing [Done]` | Undated work carrying workflow state |
| Comment | `# text` | `# Waiting for final dates` | Ignored by parsing and all derived views |

### Schedule declarations

A named schedule begins with `!` at the start of a line.

```text
! Offseason - Aug 7, 2026 - Jan 5
! Build Season
! Tasks (Bob) 2026
!% Birthdays & Holidays 2026
```

- A declaration starts a new schedule section. Following task lines belong to that schedule until the next `!` declaration.
- A schedule may declare one or more default resources in parentheses. Both `! Project (Bob) 2026` and `! Project 2026 (Bob)` are accepted.
- A schedule may provide both a start and end date or omit both dates.
- A trailing year without a date range anchors yearless items to that year. The displayed range is still derived from the section's dated items.
- The separator before a full date range is optional, so both `! Holidays - Jan 1 2026 - Dec 31` and `! Holidays Jan 1 2026 - Dec 31` are accepted.
- If an explicit range is supplied, it controls the visible range for that schedule.
- If only one endpoint contains a year, CalTaskLog infers the other year. In the Offseason example, `Jan 5` becomes January 5, 2027 because it follows August 7, 2026.
- If both endpoints omit their years, the start uses the current year in the configured timezone. The end rolls into the following year only when the written range would otherwise run backward.
- A schedule with an explicit year becomes a year anchor for yearless tasks in that section.
- If the schedule omits its range, CalTaskLog derives it from the earliest and latest dated tasks, adding one day before and one day after.
- A schedule containing only undated tasks has no meaningful chart range. Internally, CalTaskLog uses a small range around today so the document remains renderable; the Tasks view is the useful view for that schedule.
- Tasks entirely outside an explicit schedule range are reported as errors.

If the document contains tasks but no `!` declarations, CalTaskLog creates one implicit default schedule. The schedule selector is hidden in that case.

### Events versus tasks

Use `!%` to make an entire schedule an event schedule. Inside a normal `!` schedule, prefix an individual line with `%` to make only that item an event.

```text
!% Community Events 2026
Aug 8: Open house
Aug 31: Picnic [cancelled]
Sep 8: Workshop [rescheduled - TBD]

! Project 2026
:Do a thing
%Aug 20: Launch party
:Do another thing
```

- Events remain visible in Gantt and Calendar for planning. Timeline shows only events that are still upcoming or in progress.
- Events are excluded from Today, Groups, and Tasks.
- Items in an event schedule may still be nested. In a normal task schedule, `%` applies only to the line carrying it, allowing task and event hierarchies to be mixed deliberately.
- An event is considered complete after its end date passes. A canceled event is also terminal. Completed events are visually subdued in planning views.
- `canceled` and `cancelled` are both recognized. Canceled labels are struck through; rescheduled labels retain their status and receive a dashed treatment.
- Events use the same dates, times, RRULEs, colors, links, metadata, indentation, and colon requirement as tasks.

### Dated tasks and events

A dated task starts with one date or date range. The colon separates that date expression from the task detail.

```text
Aug 10: Single-day task
Aug 10-12: Same-month range
Aug 10-Aug 20: Explicit same-year range
Dec 5-Jan 8: Range crossing months or years
Aug 10, 2026-Aug 20, 2026: Fully explicit range
```

Important date rules:

- Month names are case-insensitive. Standard short or full English month names are accepted.
- `Sep`, `Sept`, and `September` are accepted. The legacy typo `Set` is also recognized, but should not be generated.
- Years are optional.
- A one-date task has the same start and end date.
- In a same-month shorthand such as `Aug 10-12`, the month is copied to the end date.
- When an inferred end date would be before its start and the end has no explicit year, the end is moved to the following year.
- Dates are inclusive. `Aug 10-12` occupies three days.
- Every task line must contain a colon, including structural and undated tasks.

By default, a yearless standalone date uses the current year—even if the current month is December and the written month is January. A yearless `!%` event schedule also anchors all of its dates to the current year without an Edit warning. Other unanchored dates show a non-blocking warning. There are two additional exceptions:

1. A range whose end would be before its start rolls the yearless end into the following year, as in `Dec 1-Jan 1`.
2. A task inherits an explicit year range from its closest dated parent, or from its schedule declaration. Within a cross-year inherited range, the parser selects the year that places the child on or after the inherited start.

### Times and all-day events

Times are optional and currently supported on single-date tasks.

```text
Aug 7 2:30-3:30p: Chassis Design
Sep 24 12:00pm: Kit and Kickoff
Aug 7 14:30-15:30: Chassis Design review
```

- Start and end times are stored as minutes after midnight.
- A single time is treated as the item's start time; an end time is optional.
- A missing meridiem is inferred from the other endpoint when possible; `2:30-3:30p` means 2:30 PM through 3:30 PM.
- If no time is written, both time values are `null` and the task is an all-day event.
- Calendar labels include a timed item's start time as `Task name@3:30pm`. Other views continue to show the task name and date span without adding time text.

### Calendar timezone

Set one IANA timezone for the entire document:

```text
@timezone=America/New_York
```

The timezone controls the current date, current year for unanchored dates, Today, and today markers. Per-event timezones are not supported.

### Repeating events

Append an iCalendar-style rule to a dated task prefix:

```text
Aug 25,rrule=FREQ=WEEKLY;BYDAY=MO,WE,FR: AI Meeting
```

Supported fields are `FREQ` (`DAILY`, `WEEKLY`, `MONTHLY`, or `YEARLY`), `INTERVAL`, `BYDAY`, `COUNT`, and `UNTIL`. `BYDAY` accepts `SU` through `SA`; `UNTIL` uses iCalendar `YYYYMMDD` or `YYYYMMDDTHHMMSSZ` form. Expansion includes the initial date and is bounded by the schedule end (and by `COUNT` or `UNTIL` when present). Repeating parent tasks are rejected; place recurrence on dated children instead.

### Derived summary parents

Leave the prefix empty when a structural parent should derive its dates from dated descendants.

```text
:Kettering
    Aug 7-10: Shooter Move
    Sep 13: Kettering Kickoff
```

- A summary parent starts undated.
- After all lines are parsed, its start becomes the earliest dated descendant start and its end becomes the latest dated descendant end.
- All descendant levels are considered, not only direct children.
- A summary with no dated descendants remains undated.
- Derived summaries appear in Gantt and Tasks when dates can be derived. A root summary also becomes a Timeline parent container; nested summaries are generally represented through their deepest dated descendants there.
- Summary parents are deliberately excluded from Today because they represent structure rather than direct work.

### Duration-relative tasks

A duration task uses an integer number of days or weeks in place of a date.

```text
5 days: Fabricate brackets
2 weeks: Test robot
```

- Its duration is inclusive; weeks are converted to seven-day units.
- It starts one day after the previous dated task at the same indentation depth.
- If there is no prior same-depth dated task, it uses its dated parent's start.
- A duration task should therefore follow a dated peer or be nested under a dated parent. Do not use an unanchored duration as the first root task.

### Undated tasks

Undated tasks are valid and are useful for tracking steps that have no calendar commitment.

```text
:Chassis Electrical Moved
:Another thing [Done]
:Research alternate motor [In Progress - waiting on vendor]
```

- A blank prefix before the required colon becomes an undated task when the item has no children.
- An optional readability hyphen before a trailing status block is ignored, so `:Another thing - [Done]` and `:Another thing [Done]` are equivalent.
- Undated tasks always appear in Tasks.
- They do not appear in Gantt, Timeline, Calendar, or Groups because those views require dates.
- They appear in Today only when their status explicitly indicates active work, such as In Progress, Active, Blocked, Stuck, or Review.

### Hierarchy and indentation

Indentation defines parent/child relationships.

```text
:Parent
    Aug 7-10: Child
        Aug 7: Grandchild
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
Aug 10-12: Shooter Move (CAD)
Aug 10-12: Field Assembly (Mechanical, Electrical)
! Website Launch (Bob) 2026
```

- Resources are stored as a list after trimming whitespace.
- Tasks with multiple resources may be repeated in multiple resource/group lanes.
- An item-level resource overrides the schedule default.
- Tasks displays the item-level resource, then the schedule default when the item has none.
- Today uses the item-level resource, then the nearest explicitly assigned ancestor, then the schedule default, and finally `Unassigned`.
- Groups does not inherit ancestor resources, but it does use the schedule default before falling back to `Unassigned`.

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

### Priority

Add a trailing priority token to a task or event detail:

```text
Sep 24: Submit registration ^P1
Sep 25: Draft robot checklist ^P2 [In Progress]
Sep 26: Reorganize spare parts ^P3
Sep 27: Archive old scouting notes ^P4
```

- `P0` is the highest priority, followed by `P1` through `P4`.
- Priorities are displayed in Today and Tasks, where the Priority filter can include one priority level or unprioritized work.
- Priorities do not change display order.

### Links

Place an HTTP or HTTPS URL at the end of the task detail inside braces. Double braces are the recommended form.

```text
Aug 10-20: Spindexer POC {{https://example.com/task}}
```

- The link must be the final metadata item.
- Single braces are accepted, but double braces are canonical.
- Linked task titles are visibly underlined and open in a new tab.
- Gantt task labels and Groups bars/milestones are linkable when a task has a link.

### Colors and comments

A trailing hexadecimal color controls the task's rendered color.

```text
Sep 3: Parent Meeting #f00
Sep 3: Parent Meeting #ff0000
Sep 3: Parent Meeting #ff000080
```

- Three-, six-, and eight-digit hexadecimal colors are valid.
- A missing color defaults to dark blue for structural parents.
- Other uncolored tasks rotate through blue, red, and yellow according to source order.
- A line whose first non-whitespace character is `#` is a comment and is ignored completely.
- Therefore, `#` at the start of a line means comment; `#hex` at the end of a task means color.

```text
# This is a comment
Aug 25: AI Meeting #0b5ea8
```

## View construction and filtering

All views operate on the currently selected schedules. Selecting multiple schedules concatenates their tasks, preserves hierarchy within each schedule, and uses the earliest selected start and latest selected end as the merged range. At least one named schedule must remain selected.

Parse errors block chart/table rendering and send the user back to Edit. Year-anchor and hierarchy warnings do not block rendering.

### Edit

Edit is the source-of-truth text editor.

- The editor uses a normal textarea with a synchronized presentation layer for syntax coloring.
- **Indent** and **Unindent** move the current or selected timeline lines by one hierarchy level while keeping the affected block selected.
- Syntax colors distinguish schedule/timezone markers, dates, times, recurrence rules, durations, resources, statuses, links, color codes, colons, and comments.
- Typing updates the item count, syntax coloring, schedule list, and warnings.
- Blank lines, comments, timezone directives, and schedule declarations are excluded from the item count.
- The protected **Default example** is always available but read-only. **Save as** opens a browser naming dialog and creates an editable named copy; canceling the dialog makes no change.
- Editable named entries save to the active workspace's IndexedDB cache. Existing browser-local entries are not migrated.
- Connect an external WebDAV folder for synchronization, or open an HTTPS plan/catalog as read-only. Save and sync failures appear in the workspace status.
- The last selected app view, Calendar subview, and selected calendars are restored after refresh. Calendar selections are remembered separately for each saved entry.

### Today

Today answers: "What should each resource be working on now?"

Candidate tasks are filtered as follows:

1. Exclude derived summary tasks.
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
- The columns are identical to Tasks: Task, Priority, Assignee, Status, Note, Start date, End date, and Timing.

#### Meeting logs

The full-width meeting-log workspace sits directly below the Today task list.

- The date rail shows every day in the recent history, including dates with no note, and can reveal earlier days in 30-day increments. A filled dot and right-aligned line count indicate that a day has content.
- Clicking a date normally opens that day's Markdown editor and live preview. Headings automatically create the preview table of contents.
- The editor uses a 2/12 date rail, 5/12 editor, and 5/12 live preview layout. Reusable meeting templates can be applied from the editor dropdown; save the current log as a new template or delete the selected template after confirmation.
- **Select days** changes the date rail to multi-select. Selecting zero or multiple dates opens the summary composer; **Done selecting** returns the rail to normal single-date behavior.
- Summary modes can concatenate complete logs chronologically, extract bullets and checkboxes under dynamically detected headings, or combine both into a hybrid output.
- Extracted items can be grouped by heading or by day. Checkbox items and the rendered/exported table of contents can each be included or omitted.
- Summaries can be copied or downloaded as Markdown. Exported Markdown includes linked table-of-contents entries when that option is enabled.
- Meeting logs and templates are separate workspace documents and remain separate from timeline plan text. Logs are daily Markdown files; templates have stable IDs and names.

### Gantt

Gantt is the continuous schedule view.

- It includes every selected task with both a start and end date: dated tasks, resolved duration tasks, and derived summary parents.
- Completed events are omitted using the same rules as Timeline: past end date, Done/Complete/Completed, or canceled/cancelled.
- Empty months wholly before the current month are removed from the horizontal scale. Enable **Show empty past months** to restore them.
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

### Timeline

Timeline is a dense month-per-row representation.

- Every visible month in the selected overall range receives one stacked section.
- Empty past months are omitted by default. Enable **Show empty past months** to restore their sections.
- Every day has the same width across every month, based on a 31-day row.
- A 31-day month fills the available date width. A 30-day or February row ends after its final day and leaves blank space on the right.
- Month rows repeat date numbers and weekday initials. Weekends are shaded.
- Only root tasks receive named rows.
- Events are omitted once their end date has passed or their status is Done, Complete, Completed, canceled, or cancelled. Their task and event descendants remain eligible and are promoted when no visible ancestor remains.
- A root task with no children renders as a solid range line or a single-day milestone.
- A root task with children renders as a translucent outlined parent container.
- Inside a parent container, CalTaskLog renders the deepest dated descendants: a dated descendant is omitted when it has another dated descendant below it.
- Overlapping descendant date ranges are packed into separate eight-pixel lanes. Ranges that share a date are considered overlapping.
- Parent rows expand vertically to fit all overlap lanes.
- Tasks are clipped to each month. A parent continuing from the prior month has an open left edge; one continuing into the next month has an open right edge.
- Undated roots and descendants are omitted.

### Calendar

Calendar is a Google Calendar-style schedule with Month, 7-day, and 4-day views.

- Previous and Next paginate by one month, seven days, or four days according to the selected view; Today returns to the current date when it is inside the selected schedule range.
- Month uses six Sunday-through-Saturday rows, including muted dates from adjacent months. The shorter views show one expanded row with dated weekday headings.
- Every dated task is shown, including derived parents, children, duration tasks, and completed tasks. Undated tasks remain exclusive to task-oriented views because they have no calendar position.
- Multi-day tasks render as continuous named bars. Bars wrap into another segment only at a displayed row boundary, and square edges show that the task continues.
- Overlapping tasks receive separate lanes and rows expand to ensure no scheduled task is hidden.
- Linked tasks remain clickable, weekends are lightly shaded, and the current date is highlighted.

### Groups

Groups is a resource-oriented Gantt view across the full continuous schedule.

- Only scheduled leaf-most work is shown. A dated task is excluded when it has another dated descendant, preventing parent and child bars from duplicating the same work.
- Past months with no grouped tasks are removed from the horizontal scale unless **Show empty past months** is enabled.
- Resources come only from the task's own parentheses in this view; they are not inherited.
- Tasks with no explicit resource appear under `Unassigned`.
- Tasks with multiple resources appear in every named group.
- Groups are alphabetical, with `Unassigned` last.
- Tasks within a group are ordered by start date and then end date.
- The time scale, month/day header, weekend grid, and today marker match Gantt.
- Single-day tasks use milestones; longer tasks use bars.
- Linked labels and plotted marks are clickable.

### Tasks

Tasks is the complete task inventory. Events are deliberately omitted.

- Every parsed task appears, including dated, duration, summary, and undated tasks.
- Rows remain in source order.
- Indentation mirrors the source hierarchy.
- Rows with children receive parent styling.
- Linked titles are clickable.
- Columns are Task, Priority, Assignee, Status, Note, Start date, End date, and Timing. The Priority filter is available in both Tasks and Today.
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

| Task kind | Edit | Today | Gantt | Timeline | Calendar | Groups | Tasks |
|---|---:|---:|---:|---:|---:|---:|---:|
| Dated task | Source | Active, overdue, or active status; not Done | Yes | Yes, subject to root/deepest-descendant rules | Yes | Leaf-most dated work | Yes |
| Derived summary | Source | No | If dates derive | If root and dates derive | If dates derive | No when it has dated descendants | Yes |
| Duration task | Source | After resolution, same Today rules | If resolved | If resolved and selected by hierarchy rules | If resolved | If resolved and leaf-most | Yes |
| Repeating task occurrence | Derived from RRULE | Same Today rules | Yes | Yes | Yes | Yes when leaf-most | Yes |
| Undated task | Source | Only with explicit active status | No | No | No | No | Yes |
| Done task | Source | No | Yes when dated | Yes when dated | Yes when dated | Yes when dated and leaf-most | Yes |
| Event | Source | No | Until completed | Until completed | Yes when dated | No | No |
| Comment | Source only | No | No | No | No | No | No |

## Implementation notes

- The parser and views are in `index.html`; the workspace, storage, and interchange code are separate static JavaScript/CSS files with no external runtime dependencies.
- The configured IANA timezone controls the current date; it defaults to the browser timezone when no directive is present.
- Dates remain calendar-day values. Optional times are stored separately as nullable minute offsets and appear in Calendar labels when present.
- Day differences are calculated in whole calendar-day increments.
- Rendering is regenerated from the editor text; the parsed task list is not independently editable.
- Schedule selection changes every derived view but not the source text.
- When changing parsing or filtering logic, update this README and add a regression fixture that covers the affected syntax and view.
