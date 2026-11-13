package main

import (
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"
)

// ---- palette

type rgb struct{ r, g, b int }

func (c rgb) fg() string { return fmt.Sprintf("\x1b[38;2;%d;%d;%dm", c.r, c.g, c.b) }

func mix(a, b rgb, t float64) rgb {
	at := func(x, y int) int { return int(math.Round(float64(x) + (float64(y)-float64(x))*t)) }
	return rgb{at(a.r, b.r), at(a.g, b.g), at(a.b, b.b)}
}

// palette is how a screen is coloured: "neon" paints its own dark ground in
// true colour, "theme" keeps the terminal's ground and uses its 16 colours.
type palette struct {
	base string            // ground and default text, restored before every piece
	role map[string]string // text, dim, frame, cyan, magenta, ok, warn, crit
	grad func(t float64, level string) string
}

var (
	neonGround  = rgb{7, 8, 13}
	neonText    = rgb{216, 246, 255}
	neonDim     = rgb{78, 96, 124}
	neonFrame   = rgb{28, 98, 128}
	neonCyan    = rgb{0, 229, 255}
	neonViolet  = rgb{139, 92, 255}
	neonMagenta = rgb{255, 43, 214}
	neonAmber   = rgb{255, 176, 0}
	neonOrange  = rgb{255, 110, 60}
	neonRed     = rgb{255, 59, 92}
)

func gradient(stops []rgb, t float64) rgb {
	t = math.Max(0, math.Min(1, t))
	span := t * float64(len(stops)-1)
	i := int(span)
	if i >= len(stops)-1 {
		return stops[len(stops)-1]
	}
	return mix(stops[i], stops[i+1], span-float64(i))
}

func paletteFor(name string) palette {
	if name == "theme" {
		levels := map[string][2]string{"ok": {"36", "96"}, "warn": {"33", "93"}, "crit": {"31", "91"}}
		return palette{
			base: "",
			role: map[string]string{
				"text": "\x1b[39m", "dim": "\x1b[90m", "frame": "\x1b[90m", "cyan": "\x1b[96m",
				"magenta": "\x1b[95m", "ok": "\x1b[96m", "warn": "\x1b[93m", "crit": "\x1b[91m",
			},
			grad: func(t float64, level string) string {
				pair := levels[level]
				if t < 0.5 {
					return "\x1b[" + pair[0] + "m"
				}
				return "\x1b[" + pair[1] + "m"
			},
		}
	}
	stops := map[string][]rgb{
		"ok":   {neonCyan, neonViolet, neonMagenta},
		"warn": {neonAmber, neonOrange},
		"crit": {neonRed, neonMagenta},
	}
	return palette{
		base: fmt.Sprintf("\x1b[48;2;%d;%d;%dm", neonGround.r, neonGround.g, neonGround.b) + neonText.fg(),
		role: map[string]string{
			"text": neonText.fg(), "dim": neonDim.fg(), "frame": neonFrame.fg(), "cyan": neonCyan.fg(),
			"magenta": neonMagenta.fg(), "ok": neonCyan.fg(), "warn": neonAmber.fg(), "crit": neonRed.fg(),
		},
		grad: func(t float64, level string) string { return gradient(stops[level], t).fg() },
	}
}

const bold = "\x1b[1m"

// ---- a line of coloured pieces that knows its width

type piece struct{ style, text string }

type line struct {
	pieces []piece
	width  int
}

func (l *line) add(style, text string) *line {
	l.pieces = append(l.pieces, piece{style, text})
	l.width += utf8.RuneCountInString(text)
	return l
}

func (l *line) addLine(o line) *line {
	l.pieces = append(l.pieces, o.pieces...)
	l.width += o.width
	return l
}

func (l *line) pad(width int) *line {
	if width > l.width {
		l.add("", strings.Repeat(" ", width-l.width))
	}
	return l
}

func (l line) render(p palette) string {
	var b strings.Builder
	for _, pc := range l.pieces {
		b.WriteString("\x1b[0m" + p.base + pc.style + pc.text)
	}
	return b.String()
}

func cut(s string, width int) string {
	if width <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= width {
		return s
	}
	r := []rune(s)
	if width == 1 {
		return "…"
	}
	return string(r[:width-1]) + "…"
}

// ---- pieces of the screen

// Big digits, three cells wide and three rows high.
var glyphs = map[rune][3]string{
	'0': {"┏━┓", "┃ ┃", "┗━┛"},
	'1': {" ┓ ", " ┃ ", " ┻ "},
	'2': {"┏━┓", "┏━┛", "┗━━"},
	'3': {"┏━┓", " ━┫", "┗━┛"},
	'4': {"╻ ╻", "┗━┫", "  ╹"},
	'5': {"┏━━", "┗━┓", "┗━┛"},
	'6': {"┏━━", "┣━┓", "┗━┛"},
	'7': {"━━┓", "  ┃", "  ╹"},
	'8': {"┏━┓", "┣━┫", "┗━┛"},
	'9': {"┏━┓", "┗━┫", "┗━┛"},
	'-': {"   ", "━━━", "   "},
	'%': {"◦ ╱", " ╱ ", "╱ ◦"},
}

// bigWidth fits three digits and a percent sign.
const bigWidth = 4*3 + 3

func bigNumber(text string) [3]string {
	var rows [3]string
	slots := 3 - utf8.RuneCountInString(text)
	for r := range rows {
		rows[r] = strings.Repeat("    ", max(0, slots))
		for _, ch := range text {
			rows[r] += glyphs[ch][r] + " "
		}
		rows[r] += glyphs['%'][r]
	}
	return rows
}

func percentText(l *Limit) string {
	return fmt.Sprintf("%d", int(math.Round(math.Max(0, math.Min(999, l.Percent)))))
}

// bar is `width` cells, the used share filled with a gradient.
func bar(p palette, percent float64, width int, level string) line {
	var l line
	filled := int(math.Round(math.Max(0, math.Min(100, percent)) / 100 * float64(width)))
	if percent > 0 && filled == 0 {
		filled = 1
	}
	for i := 0; i < width; i++ {
		if i < filled {
			l.add(p.grad(float64(i)/math.Max(1, float64(width-1)), level), "▌")
		} else {
			l.add(p.role["frame"], "▌")
		}
	}
	return l
}

var levelName = map[string]string{"ok": "NOMINAL", "warn": "ELEVATED", "crit": "CRITICAL"}

func resetsAt(l *Limit) (time.Time, bool) {
	if l == nil || l.ResetsAt == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, l.ResetsAt)
	return t, err == nil
}

type card struct {
	title   string
	limit   *Limit
	missing string // why there's nothing to show
}

func (c card) status(p palette) (string, string) {
	if c.limit == nil {
		return p.role["dim"], "NO SIGNAL"
	}
	level := Level(c.limit)
	return p.role[level] + bold, levelName[level]
}

func top(p palette, width int, title string, rightStyle, right string) line {
	var l line
	title = cut(title, width-utf8.RuneCountInString(right)-10)
	l.add(p.role["frame"], "╭─").add(p.role["magenta"], "◆ ").add(p.role["text"]+bold, title).add("", " ")
	fill := width - l.width - utf8.RuneCountInString(right) - 4
	l.add(p.role["frame"], strings.Repeat("─", max(1, fill))).add("", " ").add(rightStyle, right).add(p.role["frame"], " ─╮")
	return l
}

func framed(p palette, width int, inner line) line {
	var l line
	l.add(p.role["frame"], "│ ").addLine(*inner.pad(width - 4))
	return *l.add(p.role["frame"], " │")
}

// fullCard is five rows: big digits on the left, bar and reset time on the right.
func fullCard(p palette, c card, at time.Time, width int) []line {
	style, status := c.status(p)
	rows := []line{top(p, width, c.title, style, status)}
	right := width - 4 - bigWidth - 3
	var big [3]string
	var info [3]line
	bigStyle := p.role["dim"]
	if c.limit == nil {
		big = bigNumber("-")
		info[0].add(p.role["dim"], "NO SIGNAL")
		info[1].add(p.role["dim"], cut(c.missing, right))
	} else {
		level := Level(c.limit)
		bigStyle = p.role[level] + bold
		big = bigNumber(percentText(c.limit))
		info[0] = bar(p, c.limit.Percent, right, level)
		if t, ok := resetsAt(c.limit); ok {
			info[1].add(p.role["dim"], "RESET IN  ").add(p.role["text"]+bold, Countdown(t.Sub(at)))
			info[2].add(p.role["dim"], "AT        ").add(p.role["text"], t.Local().Format("Mon 02 Jan · 15:04"))
		} else {
			info[1].add(p.role["dim"], "RESET     ").add(p.role["dim"], "unknown")
		}
	}
	for r := 0; r < 3; r++ {
		var inner line
		inner.add(bigStyle, big[r]).add("", "   ").addLine(info[r])
		rows = append(rows, framed(p, width, inner))
	}
	var bottom line
	bottom.add(p.role["frame"], "╰"+strings.Repeat("─", width-2)+"╯")
	return append(rows, bottom)
}

// compactCard is three rows, for a short or narrow terminal.
func compactCard(p palette, c card, at time.Time, width int) []line {
	if c.limit == nil {
		var mid, bottom line
		mid.add(p.role["dim"], cut(c.missing, width-4))
		bottom.add(p.role["frame"], "╰"+strings.Repeat("─", width-2)+"╯")
		return []line{top(p, width, c.title, p.role["dim"], "NO SIGNAL"), framed(p, width, mid), bottom}
	}
	level := Level(c.limit)
	rows := []line{top(p, width, c.title, p.role[level]+bold, percentText(c.limit)+"%")}
	rows = append(rows, framed(p, width, bar(p, c.limit.Percent, width-4, level)))
	var bottom line
	bottom.add(p.role["frame"], "╰─ ")
	if t, ok := resetsAt(c.limit); ok {
		left := Countdown(t.Sub(at))
		when := t.Local().Format("Mon 15:04")
		bottom.add(p.role["dim"], "RESET ").add(p.role["text"]+bold, left)
		fill := width - bottom.width - utf8.RuneCountInString(when) - 5
		if fill >= 1 {
			bottom.add("", " ").add(p.role["frame"], strings.Repeat("─", fill)).add("", " ").add(p.role["dim"], when).add("", " ")
		}
	}
	bottom.add(p.role["frame"], strings.Repeat("─", max(0, width-bottom.width-1))+"╯")
	return append(rows, bottom)
}

// ---- the screen

type state struct {
	report   *Report
	err      error
	loading  bool
	syncedAt time.Time
	nextAt   time.Time
	model    string
}

func (s state) cards() []card {
	model := strings.ToUpper(s.model)
	missing := "waiting for the first sync"
	if s.err != nil {
		missing = "no data: " + s.err.Error()
	}
	cards := []card{
		{title: "SESSION · 5H", missing: missing},
		{title: "WEEKLY · ALL MODELS", missing: missing},
		{title: "WEEKLY · " + model, missing: missing},
	}
	if s.report != nil {
		r := s.report
		cards[0].limit, cards[1].limit, cards[2].limit = r.Session, r.Weekly, r.Model
		cards[0].missing, cards[1].missing = "not reported for this plan", "not reported for this plan"
		cards[2].missing = "no " + s.model + " limit on this plan"
		if len(r.Models) > 0 {
			cards[2].missing += " (has: " + strings.Join(r.Models, ", ") + ")"
		}
	}
	return cards
}

// screen draws every row, each exactly `cols` wide, at most `rows` of them.
func screen(s state, at time.Time, cols, rows int, p palette) []string {
	width := min(cols-4, 68)
	if width < 30 {
		width = max(cols, 10)
	}
	left := max(0, (cols-width)/2)
	compact := rows < 24 || width < 52

	var out []line
	blank := line{}
	out = append(out, blank)

	// Header: name on the left, link state and clock on the right.
	var head line
	head.add(p.role["magenta"]+bold, "◢◤ ").add(p.role["cyan"]+bold, "CLAUDE").add(p.role["dim"], " // ").add(p.role["text"]+bold, "TELEMETRY")
	dotStyle, linkWord := p.role["cyan"], "LIVE"
	switch {
	case s.report == nil && s.err != nil:
		dotStyle, linkWord = p.role["crit"], "OFFLINE"
	case s.report == nil:
		dotStyle, linkWord = p.role["dim"], "SYNCING"
	case s.err != nil:
		dotStyle, linkWord = p.role["warn"], "STALE"
	}
	if at.Second()%2 == 1 {
		dotStyle = p.role["dim"]
	}
	var link line
	link.add(dotStyle, "● ").add(p.role["text"]+bold, linkWord).add(p.role["dim"], "  "+at.Format("15:04:05"))
	if head.width+link.width+2 <= width {
		head.pad(width - link.width).addLine(link)
	}
	out = append(out, head)

	var sub line
	plan := "—"
	if s.report != nil && s.report.Plan != "" {
		plan = s.report.Plan
	}
	sub.add(p.role["dim"], "PLAN ").add(p.role["text"], plan)
	synced := "--:--:--"
	if !s.syncedAt.IsZero() {
		synced = s.syncedAt.Format("15:04:05")
	}
	var syncLine line
	syncLine.add(p.role["dim"], "SYNC ").add(p.role["text"], synced)
	if sub.width+syncLine.width+2 <= width {
		sub.pad(width - syncLine.width).addLine(syncLine)
	}
	out = append(out, sub)

	var rule line
	for i := 0; i < width; i++ {
		rule.add(p.grad(float64(i)/float64(max(1, width-1)), "ok"), "━")
	}
	out = append(out, rule, blank)

	for _, c := range s.cards() {
		if compact {
			out = append(out, compactCard(p, c, at, width)...)
		} else {
			out = append(out, fullCard(p, c, at, width)...)
			out = append(out, blank)
		}
	}
	if compact {
		out = append(out, blank)
	}

	var foot line
	if s.err != nil {
		foot.add(p.role["crit"], cut("▲ "+s.err.Error(), width))
	} else {
		foot.add(p.role["cyan"], "[R]").add(p.role["dim"], " REFRESH  ").add(p.role["cyan"], "[Q]").add(p.role["dim"], " QUIT")
		next := "--:--"
		if s.loading {
			next = "now"
		} else if !s.nextAt.IsZero() {
			d := s.nextAt.Sub(at).Round(time.Second)
			next = fmt.Sprintf("%02d:%02d", int(d/time.Minute), int(d/time.Second)%60)
		}
		var right line
		right.add(p.role["dim"], "NEXT SYNC ").add(p.role["text"], next)
		if foot.width+right.width+2 <= width {
			foot.pad(width - right.width).addLine(right)
		}
	}
	out = append(out, foot)

	lines := make([]string, 0, rows)
	for i, l := range out {
		if i >= rows {
			break
		}
		var full line
		full.add("", strings.Repeat(" ", left)).addLine(l)
		full.pad(cols)
		lines = append(lines, full.render(p))
	}
	return lines
}
