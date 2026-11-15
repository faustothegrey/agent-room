-- Compile with the README commands (osacompile -s: a stay-open app). This launcher intentionally
-- uses this project only. It serves nothing itself: if agent-room's server (one process for all its
-- rooms) answers on port 5566 it opens its first room's page; otherwise it starts the server with
-- npm start, without replication (add --node Mac --peer charon=http://192.168.178.70:5566 to turn it on). Then it follows the heartbeat (/__health):
-- clicking the Dock icon again reopens the page, Quit shuts the server down (every room), and the
-- app quits once the server has stopped.
-- Globals, not properties: an applet saves properties into itself, which would break its signature.
global roomUrl, misses, startedHere

on logFile()
    return (POSIX path of (path to library folder from user domain)) & "Logs/agent-room.log"
end logFile

-- Whether an agent-room server answers at base (http://127.0.0.1:<port>).
on answers(base)
    try
        return (do shell script "/usr/bin/curl -fsm 2 " & quoted form of (base & "/__health")) contains "\"app\":\"agent-room\""
    on error
        return false
    end try
end answers

on showLog(title)
    set tailText to ""
    try
        set tailText to do shell script "/usr/bin/tail -n 20 " & quoted form of logFile()
    end try
    display alert title message (tailText & return & return & "Log: " & logFile()) as critical
end showLog

on run
    set misses to 0
    set startedHere to false
    set roomUrl to "http://127.0.0.1:5566"
    if answers(roomUrl) then
        do shell script "/usr/bin/open " & quoted form of (roomUrl & "/__room")
        return
    end if
    set projectDir to "/Users/fausto/Software/agent-room"
    set roomCommand to "export PATH=\"/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH\"; cd " & quoted form of projectDir & " || exit; for tool in node claude codex; do command -v \"$tool\" >/dev/null || { echo \"Missing required CLI: $tool\"; exit 1; }; done; exec npm start -- --open"
    -- Start it in the background, then read its address from the log: 5566, unless something
    -- other than agent-room holds that port. Empty if it stopped before printing one.
    set roomUrl to do shell script "/bin/zsh -lc " & quoted form of roomCommand & " > " & quoted form of logFile() & " 2>&1 < /dev/null & pid=$!; for i in $(seq 100); do u=$(/usr/bin/sed -nE 's#^Discussion screen: (http://[^/]+)/__room.*#\\1#p' " & quoted form of logFile() & "); [ -n \"$u\" ] && { echo \"$u\"; exit 0; }; kill -0 $pid 2>/dev/null || exit 0; sleep .2; done"
    set startedHere to true
    if roomUrl is "" then
        set roomUrl to missing value
        showLog("Agent Room could not start")
        quit
    end if
end run

-- The heartbeat, every 3 seconds. Five missed beats in a row (about 10 seconds, longer than a
-- Restart takes) mean the server has stopped; if this app started it and its log doesn't end with
-- a normal end, the log's tail is shown.
on idle
    if roomUrl is missing value then return 5
    if answers(roomUrl) then
        set misses to 0
        return 3
    end if
    set misses to misses + 1
    if misses < 5 then return 2
    set roomUrl to missing value
    if startedHere then
        if (do shell script "/usr/bin/tail -n 1 " & quoted form of logFile()) is not "Server ended." then showLog("Agent Room ended with an error")
    end if
    quit
end idle

-- Clicking the Dock icon while the server runs reopens its first room's page.
on reopen
    try
        if roomUrl is not missing value then do shell script "/usr/bin/open " & quoted form of (roomUrl & "/__room")
    end try
end reopen

-- Keep the HTTP status as well as the body: a busy server returns its warning with 409.
on shutdownRequest(endpoint)
    return do shell script "/usr/bin/curl -sS -m 5 -w '\n%{http_code}' -H 'Content-Type: application/json' -H " & quoted form of ("Origin: " & roomUrl) & " -d '{}' " & quoted form of (roomUrl & endpoint)
end shutdownRequest

-- A busy server must be confirmed before anything stops. Cancel (including Escape) returns
-- without continuing quit, so both this stay-open launcher and the server keep running.
on quit
    if roomUrl is not missing value then
        try
            set response to shutdownRequest("/__shutdown")
            set responseCode to last paragraph of response
            if responseCode is "409" then
                set warningText to text 1 thru -5 of response
                display alert "Shutdown server?" message warningText buttons {"Cancel", "Shutdown"} default button "Cancel" cancel button "Cancel" as warning
                set response to shutdownRequest("/__shutdown?confirmed=yes")
                set responseCode to last paragraph of response
            end if
            if responseCode is not "202" then
                display alert "Server did not shut down" message response as warning
                return
            end if
        on error errorText number errorNumber
            if errorNumber is not -128 then display alert "Could not shut down the server" message errorText as warning
            return
        end try
    end if
    continue quit
end quit
