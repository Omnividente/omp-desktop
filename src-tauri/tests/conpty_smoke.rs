#![cfg(windows)]

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::{
    io::{Read, Write},
    sync::mpsc,
    thread,
    time::Duration,
};

#[test]
fn conpty_burst_drains_after_immediate_exit() {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("open ConPTY");
    let mut reader = pair.master.try_clone_reader().expect("clone ConPTY reader");
    let mut writer = pair.master.take_writer().expect("take ConPTY writer");

    let mut command = CommandBuilder::new("cmd.exe");
    command.arg("/D");
    command.arg("/Q");
    command.arg("/C");
    command.arg("(for /L %i in (0,1,999) do @echo exit-order-%i) & echo ===EXIT===");

    let mut child = pair
        .slave
        .spawn_command(command)
        .expect("spawn burst fixture in ConPTY");
    drop(pair.slave);

    // ConPTY asks the terminal for its cursor position before starting the
    // child. xterm.js answers this in the application; the isolated smoke must
    // emulate that handshake or the fixture legitimately remains blocked.
    let mut cursor_query = [0_u8; 4];
    reader
        .read_exact(&mut cursor_query)
        .expect("read ConPTY cursor-position query");
    assert_eq!(&cursor_query, b"\x1b[6n");
    writer
        .write_all(b"\x1b[1;1R")
        .expect("answer ConPTY cursor-position query");
    writer.flush().expect("flush ConPTY cursor response");

    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut output = Vec::new();
        let result = reader.read_to_end(&mut output);
        let _ = sender.send((result, output));
    });

    let status = child.wait().expect("wait for burst fixture");
    assert!(status.success(), "burst fixture must exit successfully");

    // Production performs these drops in spawn_waiter before sending the exit
    // event to the output pipeline. ConPTY keeps its output handle open until
    // the master is dropped, so reader EOF depends on this ownership cutover.
    drop(writer);
    drop(pair.master);

    let (read_result, output) = receiver
        .recv_timeout(Duration::from_secs(30))
        .expect("ConPTY reader must reach EOF after master drop");
    read_result.expect("read complete ConPTY output");

    let output = String::from_utf8_lossy(&output);
    assert!(output.contains("exit-order-0"));
    assert!(output.contains("exit-order-999"));
    assert_eq!(output.matches("exit-order-").count(), 1_000);
    assert_eq!(output.matches("===EXIT===").count(), 1);
    let final_output = output.rfind("exit-order-999").expect("find final output");
    let exit_marker = output.rfind("===EXIT===").expect("find exit marker");
    assert!(
        exit_marker > final_output,
        "exit marker must follow all output"
    );
}
