-- Compile with the README command. This launcher intentionally uses this project only.
-- Keeping do shell script in the foreground keeps one app instance alive until the room quits.
on run
    set projectDir to "/Users/fausto/Software/agent-room"
    set logFile to (POSIX path of (path to library folder from user domain)) & "Logs/agent-room.log"
    set roomCommand to "export PATH=\"/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH\"; cd " & quoted form of projectDir & " || exit; for tool in node claude codex; do command -v \"$tool\" >/dev/null || { echo \"Missing required CLI: $tool\"; exit 1; }; done; exec node src/cli.mjs --open"
    try
        do shell script "/bin/zsh -lc " & quoted form of roomCommand & " > " & quoted form of logFile & " 2>&1"
    on error errorText
        try
            set errorText to do shell script "/usr/bin/tail -n 20 " & quoted form of logFile
        end try
        display alert "Agent Room could not run" message (errorText & return & return & "Log: " & logFile) as critical
    end try
end run

-- Launch Services reopens the running app instead of starting another room.
on reopen
end reopen
