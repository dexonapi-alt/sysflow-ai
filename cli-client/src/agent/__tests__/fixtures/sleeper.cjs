// Test fixture: sleep for argv[2] ms (default 50) then exit 0.
const ms = parseInt(process.argv[2] || "50", 10)
setTimeout(() => process.exit(0), ms)
