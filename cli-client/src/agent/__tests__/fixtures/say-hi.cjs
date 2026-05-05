// Test fixture: print "hi" then sleep 200ms (so the test has time to poll
// while it's still running) then exit 0.
console.log("hi")
setTimeout(() => process.exit(0), 200)
