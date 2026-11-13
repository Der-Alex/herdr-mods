// claude-usage reads Claude's plan limits from Anthropic's usage endpoint.
//
//	claude-usage json [--model Fable]                      one read, as JSON on stdout
//	claude-usage tui  [--every 60s] [--model Fable] [--palette neon|theme]
//
// The Claude Usage mod calls `json` for its panel and opens `tui` in a terminal.
// `tui` runs in any terminal, inside Herdr or not.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"time"
)

const usageText = `usage:
  claude-usage json [--model Fable]
  claude-usage tui  [--every 60s] [--model Fable] [--palette neon|theme]
`

// The shortest pause between reads: the endpoint is shared with Claude Code.
const minEvery = 30 * time.Second

func writeJSON(w io.Writer, v any) {
	b, _ := json.Marshal(v)
	fmt.Fprintln(w, string(b))
}

func runJSON(args []string, stdout io.Writer) int {
	flags := flag.NewFlagSet("json", flag.ContinueOnError)
	model := flags.String("model", "Fable", "the model whose weekly limit to show")
	if err := flags.Parse(args); err != nil {
		writeJSON(stdout, map[string]string{"error": err.Error(), "kind": "usage"})
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	report, err := load(ctx, *model)
	if err != nil {
		writeJSON(stdout, map[string]string{"error": err.Error(), "kind": errorKind(err)})
		return 1
	}
	writeJSON(stdout, report)
	return 0
}

func runTUI(args []string) int {
	flags := flag.NewFlagSet("tui", flag.ContinueOnError)
	model := flags.String("model", "Fable", "the model whose weekly limit to show")
	every := flags.Duration("every", time.Minute, "how often to read the usage endpoint")
	paletteName := flags.String("palette", "neon", "neon or theme (the terminal's own colours)")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *every < minEvery {
		*every = minEvery
	}
	return tui(*model, *every, paletteFor(*paletteName))
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usageText)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "json":
		os.Exit(runJSON(os.Args[2:], os.Stdout))
	case "tui":
		os.Exit(runTUI(os.Args[2:]))
	default:
		fmt.Fprint(os.Stderr, usageText)
		os.Exit(2)
	}
}
