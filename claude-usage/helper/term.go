package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func stty(tty *os.File, args ...string) (string, error) {
	cmd := exec.Command("stty", args...)
	cmd.Stdin = tty
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

// size asks the terminal for its rows and columns, 80×24 when it can't say.
func size(tty *os.File) (int, int) {
	var rows, cols int
	if out, err := stty(tty, "size"); err == nil {
		if n, _ := fmt.Sscanf(out, "%d %d", &rows, &cols); n == 2 && rows > 0 && cols > 0 {
			return cols, rows
		}
	}
	return 80, 24
}

type result struct {
	report Report
	err    error
}

// tui draws the usage full screen until q, Ctrl-C or the terminal closes. It
// reads the endpoint every `every` and counts the resets down each second.
func tui(model string, every time.Duration, p palette) int {
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		tty = os.Stdin
	}
	// Keys arrive one at a time, unechoed; Ctrl-C still interrupts.
	if saved, err := stty(tty, "-g"); err == nil {
		stty(tty, "-icanon", "-echo", "min", "1", "time", "0")
		defer stty(tty, saved)
	}
	os.Stdout.WriteString("\x1b[?1049h\x1b[?25l")
	defer os.Stdout.WriteString("\x1b[0m\x1b[?25h\x1b[?1049l")

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	resize := make(chan os.Signal, 1)
	signal.Notify(resize, syscall.SIGWINCH)
	keys := make(chan byte)
	go func() {
		buf := make([]byte, 1)
		for {
			if n, err := tty.Read(buf); err != nil || n == 0 {
				return
			} else {
				keys <- buf[0]
			}
		}
	}()
	results := make(chan result, 1)

	s := state{model: model}
	refresh := func() {
		s.loading = true
		s.nextAt = now().Add(every)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			report, err := load(ctx, model)
			results <- result{report, err}
		}()
	}
	cols, rows := size(tty)
	draw := func() {
		lines := screen(s, now(), cols, rows, p)
		os.Stdout.WriteString("\x1b[H" + strings.Join(lines, "\x1b[0m"+p.base+"\x1b[K\r\n") + "\x1b[0m" + p.base + "\x1b[K\x1b[J")
	}
	refresh()
	draw()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return 0
		case <-resize:
			cols, rows = size(tty)
			draw()
		case key := <-keys:
			switch key {
			case 'q', 'Q', 3:
				return 0
			case 'r', 'R':
				if !s.loading {
					refresh()
				}
			}
			draw()
		case r := <-results:
			s.loading = false
			if r.err != nil {
				s.err = r.err
			} else {
				s.report, s.err, s.syncedAt = &r.report, nil, now()
			}
			draw()
		case <-tick.C:
			if !s.loading && !now().Before(s.nextAt) {
				refresh()
			}
			draw()
		}
	}
}
