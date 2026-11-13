package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// A trimmed answer from the usage endpoint, as it came on 2026-11-13.
const answer = `{
 "five_hour": {"utilization": 6.0, "resets_at": "2026-11-13T10:39:59.689881+00:00"},
 "seven_day": {"utilization": 23.0, "resets_at": "2026-11-17T02:59:59.689899+00:00"},
 "seven_day_opus": null,
 "limits": [
  {"kind": "session", "group": "session", "percent": 6, "severity": "normal", "resets_at": "2026-11-13T10:39:59.689881+00:00", "scope": null},
  {"kind": "weekly_all", "group": "weekly", "percent": 23, "severity": "normal", "resets_at": "2026-11-17T02:59:59.689899+00:00", "scope": null},
  {"kind": "weekly_scoped", "group": "weekly", "percent": 41, "severity": "normal", "resets_at": "2026-11-17T02:59:59.690039+00:00",
   "scope": {"model": {"id": null, "display_name": "Fable"}, "surface": null}}
 ]
}`

var fixed = time.Date(2026, 11, 13, 9, 21, 7, 0, time.UTC)

func fakeLogin(t *testing.T, creds string, handler http.HandlerFunc) {
	t.Helper()
	server := httptest.NewServer(handler)
	oldEndpoint, oldRead, oldNow := endpoint, readCredentials, now
	t.Cleanup(func() { server.Close(); endpoint, readCredentials, now = oldEndpoint, oldRead, oldNow })
	endpoint = server.URL
	readCredentials = func() ([]byte, error) { return []byte(creds), nil }
	now = func() time.Time { return fixed }
}

const goodLogin = `{"claudeAiOauth":{"accessToken":"tok","expiresAt":1893456000000,"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}`

func TestParseReadsLimitsAndThePickedModel(t *testing.T) {
	r, err := parse([]byte(answer), "fable")
	if err != nil {
		t.Fatal(err)
	}
	if r.Session.Percent != 6 || r.Weekly.Percent != 23 || r.Model.Percent != 41 {
		t.Fatalf("report %+v", r)
	}
	if r.ModelName != "Fable" || r.Model.ResetsAt != "2026-11-17T02:59:59.690039+00:00" || len(r.Models) != 1 {
		t.Fatalf("model %+v %v", r.Model, r.Models)
	}
}

func TestParseFallsBackToWindowsAndNamesOtherModels(t *testing.T) {
	r, err := parse([]byte(`{"five_hour":{"utilization":12,"resets_at":"x"},"seven_day":{"utilization":50},
	  "limits":[{"kind":"weekly_scoped","percent":3,"scope":{"model":{"display_name":"Opus"}}}]}`), "Fable")
	if err != nil {
		t.Fatal(err)
	}
	if r.Session.Percent != 12 || r.Weekly.Percent != 50 || r.Model != nil || r.Models[0] != "Opus" {
		t.Fatalf("report %+v", r)
	}
	if _, err := parse([]byte("<html>"), "Fable"); errorKind(err) != "api" {
		t.Fatalf("err %v", err)
	}
}

func TestLoadSendsTheTokenAndReportsThePlan(t *testing.T) {
	fakeLogin(t, goodLogin, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" || r.Header.Get("anthropic-beta") != "oauth-2025-04-20" {
			w.WriteHeader(400)
			return
		}
		w.Write([]byte(answer))
	})
	var out bytes.Buffer
	if code := runJSON([]string{"--model", "Fable"}, &out); code != 0 {
		t.Fatalf("code %d: %s", code, out.String())
	}
	var r Report
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	if r.Plan != "MAX 20X" || r.FetchedAt != "2026-11-13T09:21:07Z" || r.Model.Percent != 41 {
		t.Fatalf("report %+v", r)
	}
}

func TestLoginProblemsHaveKinds(t *testing.T) {
	cases := []struct {
		creds  string
		status int
		kind   string
	}{
		{`{"claudeAiOauth":{"accessToken":"tok","expiresAt":1000}}`, 200, "expired"},
		{`{}`, 200, "login"},
		{goodLogin, 401, "expired"},
		{goodLogin, 429, "api"},
		{goodLogin, 500, "api"},
	}
	for _, c := range cases {
		fakeLogin(t, c.creds, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(c.status)
			w.Write([]byte(answer))
		})
		var out bytes.Buffer
		if code := runJSON(nil, &out); code != 1 {
			t.Fatalf("%v: code %d", c, code)
		}
		var e map[string]string
		json.Unmarshal(out.Bytes(), &e)
		if e["kind"] != c.kind || e["error"] == "" || strings.Contains(e["error"], "tok") {
			t.Fatalf("%v: %v", c, e)
		}
	}
	readCredentials = func() ([]byte, error) { return nil, &usageError{"login", "Not signed in"} }
	if _, err := load(context.Background(), "Fable"); errorKind(err) != "login" {
		t.Fatalf("err %v", err)
	}
	if errorKind(errors.New("plain")) != "api" {
		t.Fatal("plain errors are api errors")
	}
}

func TestLevelsAndCountdowns(t *testing.T) {
	for _, c := range []struct {
		l    *Limit
		want string
	}{
		{&Limit{Percent: 10, Severity: "normal"}, "ok"},
		{&Limit{Percent: 75}, "warn"},
		{&Limit{Percent: 90}, "crit"},
		{&Limit{Percent: 10, Severity: "warning"}, "warn"},
		{&Limit{Percent: 95, Severity: "warning"}, "crit"},
		{&Limit{Percent: 10, Severity: "critical"}, "crit"},
		{nil, "ok"},
	} {
		if got := Level(c.l); got != c.want {
			t.Errorf("Level(%+v) = %s, want %s", c.l, got, c.want)
		}
	}
	for d, want := range map[time.Duration]string{
		-time.Second:                                   "00h 00m 00s",
		78*time.Minute + 52*time.Second:                "01h 18m 52s",
		3*24*time.Hour + 17*time.Hour + 38*time.Minute: "3d 17h 38m",
	} {
		if got := Countdown(d); got != want {
			t.Errorf("Countdown(%v) = %s, want %s", d, got, want)
		}
	}
	if planName("pro", "") != "PRO" || planName("", "x_20x") != "" {
		t.Fatal("plan names")
	}
}

var escapes = regexp.MustCompile("\x1b\\[[0-9;?]*[A-Za-z]")

func visible(s string) string { return escapes.ReplaceAllString(s, "") }

func TestScreenRowsAreExactlyAsWideAsTheTerminal(t *testing.T) {
	r, _ := parse([]byte(answer), "Fable")
	r.Plan = "MAX 20X"
	states := []state{
		{model: "Fable"},
		{model: "Fable", report: &r, syncedAt: fixed, nextAt: fixed.Add(34 * time.Second)},
		{model: "Opus", report: &r, err: &usageError{"network", "Can't reach api.anthropic.com"}},
		{model: "Fable", err: &usageError{"expired", "Claude login expired"}},
	}
	for _, palette := range []string{"neon", "theme"} {
		p := paletteFor(palette)
		for _, s := range states {
			for _, size := range [][2]int{{120, 40}, {80, 24}, {60, 20}, {34, 30}} {
				lines := screen(s, fixed, size[0], size[1], p)
				if len(lines) > size[1] {
					t.Fatalf("%dx%d: %d rows", size[0], size[1], len(lines))
				}
				for i, l := range lines {
					if w := utf8.RuneCountInString(visible(l)); w != size[0] {
						t.Fatalf("%s %dx%d row %d is %d wide: %q", palette, size[0], size[1], i, w, visible(l))
					}
				}
			}
		}
	}
}

func TestScreenShowsTheNumbersAndTheirResets(t *testing.T) {
	r, _ := parse([]byte(answer), "Fable")
	text := visible(strings.Join(screen(state{model: "Fable", report: &r, syncedAt: fixed}, fixed, 100, 40, paletteFor("neon")), "\n"))
	for _, want := range []string{"SESSION · 5H", "WEEKLY · ALL MODELS", "WEEKLY · FABLE", "RESET IN  01h 18m 52s", "3d 17h 38m", "NOMINAL", "LIVE"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in\n%s", want, text)
		}
	}
	opus, _ := parse([]byte(answer), "Opus")
	compact := visible(strings.Join(screen(state{model: "Opus", report: &opus}, fixed, 50, 20, paletteFor("theme")), "\n"))
	for _, want := range []string{"6%", "23%", "no Opus limit on this plan (has: Fable)"} {
		if !strings.Contains(compact, want) {
			t.Errorf("missing %q in\n%s", want, compact)
		}
	}
}
