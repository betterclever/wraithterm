# The PTY's own ceiling: cat a file into a PTY and read the master with blocking
# reads on a dedicated thread, as a native terminal's IO thread does.
# python3 scripts/ghostty-native/pty-ceiling.py logs.ansi
import os, pty, subprocess, sys, time, tty
m, s = pty.openpty(); tty.setraw(s)
t = time.perf_counter(); n = reads = 0
p = subprocess.Popen(['/bin/cat', sys.argv[1]], stdout=s); os.close(s)
while True:
    try: d = os.read(m, 65536)
    except OSError: break
    if not d: break
    n += len(d); reads += 1
dt = time.perf_counter() - t
print(f'{n/1e6:.1f} MB, {reads} reads, {n/dt/1e6:.0f} MB/s')
