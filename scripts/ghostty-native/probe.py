# Runs inside a terminal. Writes each workload to the tty, then a cursor-position
# query; the terminal answers only after it has processed every earlier byte.
import json, os, sys, termios, time, tty
out, reps, files = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
fd = os.open('/dev/tty', os.O_RDWR)
old = termios.tcgetattr(fd)
tty.setraw(fd)
def barrier():
    os.write(fd, b'\x1b[6n')
    buf = b''
    while not buf.endswith(b'R'):
        buf += os.read(fd, 64)
    return buf
results = []
try:
    time.sleep(1.5)
    os.write(fd, b'\x1b[2J\x1b[H'); barrier()
    size = os.get_terminal_size(fd)
    for path in files:
        data = open(path, 'rb').read()
        for r in range(reps):
            os.write(fd, b'\x1b[0m\x1b[2J\x1b[H'); barrier()
            wall, t = time.time(), time.perf_counter()
            view = memoryview(data)
            for i in range(0, len(view), 65536):
                os.write(fd, view[i:i + 65536])
            barrier()
            dt = time.perf_counter() - t
            results.append({'file': os.path.basename(path), 'rep': r, 'bytes': len(data), 'seconds': dt, 'MBps': len(data) / dt / 1e6, 'start': wall, 'end': wall + dt})
finally:
    os.write(fd, b'\x1b[0m\x1b[2J\x1b[H\x1b_Ga=d\x1b\\')
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
    json.dump({'cols': size.columns, 'rows': size.lines, 'term': os.environ.get('TERM_PROGRAM'), 'results': results}, open(out, 'w'), indent=1)
