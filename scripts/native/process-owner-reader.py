"""Persistent targeted macOS process ownership reader, JSON lines over pipes."""

import ctypes
import errno
import json
import os
import signal
import sys

MAXIMUM_GROUP_MEMBERS = 4096
MAXIMUM_HISTORY_IDENTIFIERS = 16384
MAXIMUM_GROUPS = 4096
MAXIMUM_ARGUMENT_BYTES = 1024 * 1024
MAXIMUM_PACKET_BYTES = 1024 * 1024
MAXIMUM_REQUESTS = 65536
IMMUTABLE_KEYS = ("pid", "birthMicroseconds", "userId", "pgid", "executablePath", "argv")


class OwnershipRefusal(RuntimeError):
    pass


class ProcessInformation(ctypes.Structure):
    _fields_ = [
        (name, ctypes.c_uint32)
        for name in (
            "flags", "status", "exit_status", "identifier", "parent_identifier",
            "user_identifier", "group_identifier", "real_user_identifier",
            "real_group_identifier", "saved_user_identifier", "saved_group_identifier",
            "reserved",
        )
    ] + [
        ("command", ctypes.c_char * 16), ("name", ctypes.c_char * 32),
        ("file_count", ctypes.c_uint32), ("process_group", ctypes.c_uint32),
        ("job_count", ctypes.c_uint32), ("terminal_device", ctypes.c_uint32),
        ("terminal_group", ctypes.c_uint32), ("priority", ctypes.c_int32),
        ("birth_seconds", ctypes.c_uint64), ("birth_microseconds", ctypes.c_uint64),
    ]


def identifier(value):
    if type(value) is not int or not 0 < value < 2 ** 31:
        raise OwnershipRefusal("Invalid bounded host process identifier.")
    return value


def same_identity(expected, actual):
    return actual is not None and all(actual.get(key) == expected.get(key) for key in IMMUTABLE_KEYS)


def same_basic(expected, actual):
    return actual is not None and all(
        actual.get(key) == expected.get(key)
        for key in ("pid", "birthMicroseconds", "userId", "pgid")
    )


class KernelReader:
    def __init__(self):
        if sys.platform != "darwin":
            raise OwnershipRefusal("The targeted process owner requires macOS.")
        self.process_library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.system_library = ctypes.CDLL(None, use_errno=True)
        self.process_library.proc_pidinfo.argtypes = [
            ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int,
        ]
        self.process_library.proc_pidinfo.restype = ctypes.c_int
        self.process_library.proc_listpgrppids.argtypes = [
            ctypes.c_int, ctypes.c_void_p, ctypes.c_int,
        ]
        self.process_library.proc_listpgrppids.restype = ctypes.c_int
        self.system_library.sysctl.argtypes = [
            ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t,
        ]
        self.system_library.sysctl.restype = ctypes.c_int

    def basic(self, process_identifier):
        process_identifier = identifier(process_identifier)
        information = ProcessInformation()
        ctypes.set_errno(0)
        returned_bytes = self.process_library.proc_pidinfo(
            process_identifier, 3, 0, ctypes.byref(information), ctypes.sizeof(information),
        )
        error_number = ctypes.get_errno()
        if returned_bytes == 0 and error_number in (0, errno.ESRCH, errno.ENOENT):
            return None
        if returned_bytes != ctypes.sizeof(information):
            raise OwnershipRefusal("Incomplete targeted kernel process identity.")
        return {
            "pid": information.identifier, "parentPid": information.parent_identifier,
            "pgid": information.process_group, "status": information.status,
            "birthMicroseconds": information.birth_seconds * 1000000 + information.birth_microseconds,
            "userId": information.user_identifier,
        }

    def arguments(self, process_identifier):
        selector = (ctypes.c_int * 3)(1, 49, identifier(process_identifier))
        size = ctypes.c_size_t()
        ctypes.set_errno(0)
        if self.system_library.sysctl(selector, 3, None, ctypes.byref(size), None, 0):
            error_number = ctypes.get_errno()
            raise OwnershipRefusal(
                "Targeted kernel argument size query failed. "
                + "pid=" + str(process_identifier) + " selector=49 phase=size errno=" + str(error_number)
            )
        if not 4 < size.value <= MAXIMUM_ARGUMENT_BYTES:
            raise OwnershipRefusal("Targeted process arguments exceeded their byte bound.")
        buffer = ctypes.create_string_buffer(size.value)
        ctypes.set_errno(0)
        if self.system_library.sysctl(selector, 3, buffer, ctypes.byref(size), None, 0):
            error_number = ctypes.get_errno()
            raise OwnershipRefusal(
                "Targeted kernel argument query failed. "
                + "pid=" + str(process_identifier) + " selector=49 phase=read errno=" + str(error_number)
            )
        content = buffer.raw[:size.value]
        argument_count = int.from_bytes(content[:4], sys.byteorder, signed=True)
        if not 0 < argument_count <= 4096:
            raise OwnershipRefusal("Invalid targeted process argument count.")
        executable_end = content.index(b"\0", 4)
        executable_path = os.fsdecode(content[4:executable_end])
        position = executable_end + 1
        while position < len(content) and content[position] == 0:
            position += 1
        arguments = []
        for _ in range(argument_count):
            argument_end = content.index(b"\0", position)
            arguments.append(os.fsdecode(content[position:argument_end]))
            position = argument_end + 1
        return executable_path, arguments

    def identity(self, process_identifier):
        before = self.basic(process_identifier)
        if before is None or before["status"] == 5:
            return before
        try:
            executable_path, arguments = self.arguments(process_identifier)
        except OwnershipRefusal as argument_failure:
            try:
                closed = self.basic(process_identifier)
            except OwnershipRefusal:
                raise argument_failure
            if closed is None:
                return None
            if closed["status"] == 5 and same_basic(before, closed) and before["parentPid"] == closed["parentPid"]:
                return closed
            raise
        after = self.basic(process_identifier)
        if after is None:
            return None
        if not same_basic(before, after) or before["parentPid"] != after["parentPid"]:
            raise OwnershipRefusal("Process identity changed during targeted inspection.")
        if after["status"] == 5:
            return after
        try:
            confirmed_executable, confirmed_arguments = self.arguments(process_identifier)
        except OwnershipRefusal as argument_failure:
            try:
                closed = self.basic(process_identifier)
            except OwnershipRefusal:
                raise argument_failure
            if closed is None:
                return None
            if closed["status"] == 5 and same_basic(after, closed) and after["parentPid"] == closed["parentPid"]:
                return closed
            raise
        final = self.basic(process_identifier)
        if final is None:
            return None
        if final["status"] == 5:
            return final
        if not same_basic(after, final) or after["parentPid"] != final["parentPid"] or executable_path != confirmed_executable or arguments != confirmed_arguments:
            raise OwnershipRefusal("Executable or argv changed during targeted identity inspection.")
        return {**final, "executablePath": confirmed_executable, "argv": confirmed_arguments}

    def members(self, group_identifier):
        group_identifier = identifier(group_identifier)
        buffer = (ctypes.c_int * MAXIMUM_GROUP_MEMBERS)()
        capacity_bytes = ctypes.sizeof(buffer)
        ctypes.set_errno(0)
        returned_count = self.process_library.proc_listpgrppids(
            group_identifier, ctypes.byref(buffer), capacity_bytes,
        )
        error_number = ctypes.get_errno()
        if returned_count < 0 or error_number != 0:
            raise OwnershipRefusal("Targeted group membership query failed.")
        if returned_count >= MAXIMUM_GROUP_MEMBERS:
            raise OwnershipRefusal("Targeted group membership is incomplete or at its bound.")
        # The public convenience wrapper returns PID count, unlike proc_listpids bytes.
        members = [identifier(buffer[index]) for index in range(returned_count)]
        if len(set(members)) != len(members):
            raise OwnershipRefusal("Targeted group membership contains duplicate identities.")
        return members


class OwnershipLedger:
    def __init__(self, kernel, owner_identifier, signal_process=os.kill):
        self.kernel = kernel
        self.owner = kernel.identity(identifier(owner_identifier))
        if self.owner is None or self.owner["status"] == 5:
            raise OwnershipRefusal("The launching owner has no live kernel identity.")
        self.groups = {}
        self.history = {}
        self.signal_process = signal_process

    def verify_owner(self):
        current = self.kernel.identity(self.owner["pid"])
        if not same_identity(self.owner, current):
            raise OwnershipRefusal("The launching owner identity changed.")

    def remember(self, value, leader_identifier, parent_identifier):
        previous = self.history.get(value["pid"])
        if previous is not None:
            if not same_identity(previous["identity"], value):
                raise OwnershipRefusal("A changed or reused PID cannot be reenrolled.")
            if previous["leaderPid"] != leader_identifier:
                raise OwnershipRefusal("An enrolled PID cannot move to another launched group.")
            return
        if len(self.history) >= MAXIMUM_HISTORY_IDENTIFIERS:
            raise OwnershipRefusal("Immutable process enrollment history exceeded its bound.")
        self.history[value["pid"]] = {
            "identity": {**value, "argv": list(value["argv"])},
            "observedCurrentIdentity": {**value, "argv": list(value["argv"])},
            "leaderPid": leader_identifier, "admittedParentPid": parent_identifier,
        }

    def enroll(self, process_identifier, launched_microseconds):
        self.verify_owner()
        process_identifier = identifier(process_identifier)
        if process_identifier == os.getpid():
            raise OwnershipRefusal("The reader cannot enroll or signal itself.")
        if type(launched_microseconds) is not int or launched_microseconds <= 0:
            raise OwnershipRefusal("Invalid direct process launch boundary.")
        if process_identifier in self.groups:
            raise OwnershipRefusal("A launched group cannot be reenrolled.")
        if len(self.groups) >= MAXIMUM_GROUPS:
            raise OwnershipRefusal("Launched process group history exceeded its bound.")
        self.groups[process_identifier] = {"leaderPid": process_identifier, "leader": None}
        current = self.kernel.identity(process_identifier)
        if current is None:
            if self.kernel.members(process_identifier):
                raise OwnershipRefusal("A vanished unenrolled leader has unknown live members.")
            return {"state": "closed", "leaderPid": process_identifier}
        if (
            current["status"] == 5
            or current["parentPid"] != self.owner["pid"]
            or current["userId"] != self.owner["userId"]
            or current["pgid"] != process_identifier
            or current["birthMicroseconds"] < launched_microseconds
        ):
            raise OwnershipRefusal("Direct child kernel launch identity is not owned.")
        self.verify_owner()
        confirmed = self.kernel.identity(process_identifier)
        if not same_identity(current, confirmed) or confirmed["parentPid"] != self.owner["pid"]:
            raise OwnershipRefusal("Direct child changed before immutable enrollment.")
        self.remember(confirmed, process_identifier, self.owner["pid"])
        self.groups[process_identifier]["leader"] = confirmed
        self.discover(process_identifier, strict=False)
        return {"state": "enrolled", "leaderPid": process_identifier, "identity": confirmed}

    def fresh_enrolled_identity(self, process_identifier, leader_identifier, require_live_chain=False):
        self.verify_owner()
        visited = {}
        cursor = process_identifier
        orphan_parent = None
        while True:
            if cursor in visited or len(visited) >= MAXIMUM_GROUP_MEMBERS:
                raise OwnershipRefusal("Invalid bounded same-group parent chain.")
            expected = self.history.get(cursor)
            if expected is None or expected["leaderPid"] != leader_identifier:
                raise OwnershipRefusal("A descendant has no enrolled parent chain.")
            current = self.kernel.identity(cursor)
            if not same_basic(expected["identity"], current) or current["status"] == 5:
                current_identity_bytes = len(json.dumps(
                    current, ensure_ascii=True, separators=(",", ":"),
                ).encode("ascii"))
                current_identity_complete = current_identity_bytes <= MAXIMUM_PACKET_BYTES // 64
                refusal_detail = {
                    "cursorPid": cursor,
                    "leaderPid": leader_identifier,
                    "branch": "absent" if current is None else (
                        "basic-mismatch" if not same_basic(expected["identity"], current)
                        else "status-5"
                    ),
                    "expectedBasic": {
                        key: expected["identity"][key]
                        for key in ("pid", "birthMicroseconds", "userId", "pgid", "parentPid", "status")
                    },
                    "currentIdentity": current if current_identity_complete else {
                        key: current[key]
                        for key in ("pid", "birthMicroseconds", "userId", "pgid", "parentPid", "status")
                    },
                    "currentIdentityComplete": current_identity_complete,
                    "currentIdentityEncodedBytes": current_identity_bytes,
                }
                raise OwnershipRefusal(
                    "An enrolled incarnation is not freshly live and exact. "
                    + json.dumps(refusal_detail, ensure_ascii=True, separators=(",", ":"))
                )
            visited[cursor] = current
            if cursor == leader_identifier:
                if current["parentPid"] != self.owner["pid"]:
                    raise OwnershipRefusal("The launched leader no longer has its original owner.")
                break
            if current["parentPid"] == expected["admittedParentPid"]:
                cursor = current["parentPid"]
                continue
            # Only an already enrolled incarnation may survive its admitted parent's exit.
            # This historical gap never authorizes enrollment of a new descendant.
            parent_identifier = expected["admittedParentPid"]
            parent = self.history.get(parent_identifier)
            if current["parentPid"] != 1 or parent is None or parent["leaderPid"] != leader_identifier:
                raise OwnershipRefusal("An enrolled process has a foreign or unknown current parent.")
            parent_current = self.kernel.identity(parent_identifier)
            if parent_current is not None and (
                not same_basic(parent["identity"], parent_current) or parent_current["status"] != 5
            ):
                raise OwnershipRefusal("An enrolled process lost a still-live or changed parent.")
            if require_live_chain:
                raise OwnershipRefusal("A new descendant requires a wholly live enrolled parent chain.")
            orphan_parent = (parent_identifier, parent_current)
            break
        if orphan_parent is not None:
            parent_identifier, before = orphan_parent
            after = self.kernel.identity(parent_identifier)
            if (before is None) != (after is None) or (
                before is not None and (not same_basic(before, after) or after["status"] != 5)
            ):
                raise OwnershipRefusal("An exited enrolled parent changed during fresh inspection.")
        for current in reversed(list(visited.values())):
            confirmed = self.kernel.identity(current["pid"])
            if (
                not same_identity(current, confirmed) or confirmed["status"] == 5
                or current["parentPid"] != confirmed["parentPid"]
            ):
                raise OwnershipRefusal("An enrolled current image changed during fresh inspection.")
            visited[current["pid"]] = confirmed
        self.verify_owner()
        for current in visited.values():
            self.history[current["pid"]]["observedCurrentIdentity"] = {
                **current, "argv": list(current["argv"]),
            }
        return visited[process_identifier], set(visited)

    def parent_chain(self, parent_identifier, leader_identifier):
        _, visited = self.fresh_enrolled_identity(
            parent_identifier, leader_identifier, require_live_chain=True,
        )
        return visited

    def discover(self, leader_identifier, strict):
        leader_identifier = identifier(leader_identifier)
        if leader_identifier not in self.groups:
            raise OwnershipRefusal("Unknown launched process group.")
        members = self.kernel.members(leader_identifier)
        if not members:
            return {"state": "closed", "leaderPid": leader_identifier, "members": []}
        unresolved = set(members)
        while unresolved:
            progressed = False
            for process_identifier in list(unresolved):
                current = self.kernel.identity(process_identifier)
                if current is None:
                    unresolved.remove(process_identifier)
                    progressed = True
                    continue
                expected = self.history.get(process_identifier)
                if expected is not None:
                    if expected["leaderPid"] != leader_identifier:
                        raise OwnershipRefusal("Member belongs to a different immutable group.")
                    if current["status"] == 5:
                        if not same_basic(expected["identity"], current):
                            raise OwnershipRefusal("Enrolled pending-reap incarnation changed.")
                    else:
                        fresh, _ = self.fresh_enrolled_identity(process_identifier, leader_identifier)
                        if not same_identity(current, fresh) or current["parentPid"] != fresh["parentPid"]:
                            raise OwnershipRefusal("Enrolled current image changed during group inspection.")
                    unresolved.remove(process_identifier)
                    progressed = True
                    continue
                if current["status"] == 5 or current["pgid"] != leader_identifier or current["userId"] != self.owner["userId"]:
                    continue
                parent_identifier = current["parentPid"]
                if parent_identifier not in self.history:
                    continue
                try:
                    parent_chain = self.parent_chain(parent_identifier, leader_identifier)
                    parent_images = {
                        parent: self.history[parent]["observedCurrentIdentity"]
                        for parent in parent_chain
                    }
                    parent = self.history[parent_identifier]["identity"]
                    if current["birthMicroseconds"] < parent["birthMicroseconds"]:
                        continue
                    confirmed = self.kernel.identity(process_identifier)
                    if not same_identity(current, confirmed) or confirmed["parentPid"] != parent_identifier:
                        continue
                    confirmed_chain = self.parent_chain(parent_identifier, leader_identifier)
                    if confirmed_chain != parent_chain or any(
                        not same_identity(image, self.history[parent]["observedCurrentIdentity"])
                        or image["parentPid"] != self.history[parent]["observedCurrentIdentity"]["parentPid"]
                        for parent, image in parent_images.items()
                    ):
                        continue
                    final = self.kernel.identity(process_identifier)
                    if not same_identity(confirmed, final) or final["parentPid"] != parent_identifier:
                        continue
                    self.remember(final, leader_identifier, parent_identifier)
                except OwnershipRefusal:
                    continue
                unresolved.remove(process_identifier)
                progressed = True
            if not progressed:
                break
        final_members = self.kernel.members(leader_identifier)
        if not final_members:
            return {"state": "closed", "leaderPid": leader_identifier, "members": []}
        if set(final_members) != set(members):
            if strict:
                raise OwnershipRefusal("Group membership changed during targeted enrollment.")
            return {"state": "unknown", "leaderPid": leader_identifier, "members": final_members, "unknownMembers": sorted(set(final_members) - set(self.history))}
        if strict and unresolved:
            raise OwnershipRefusal("Live or pending group members have no safe immutable enrollment.")
        return {
            "state": "live" if not unresolved else "unknown", "leaderPid": leader_identifier,
            "members": members, "unknownMembers": sorted(unresolved),
        }

    def signal_group(self, leader_identifier, signal_name):
        if signal_name not in ("SIGTERM", "SIGKILL"):
            raise OwnershipRefusal("Unsupported individual task signal.")
        snapshot = self.discover(leader_identifier, strict=True)
        signaled = []
        for process_identifier in snapshot["members"]:
            self.discover(leader_identifier, strict=True)
            expected = self.history.get(process_identifier)
            current = self.kernel.identity(process_identifier)
            if current is None:
                continue
            if expected is None or expected["leaderPid"] != leader_identifier:
                raise OwnershipRefusal("Current signal target lacks immutable ownership.")
            if current["status"] == 5:
                if not same_basic(expected["identity"], current):
                    raise OwnershipRefusal("Pending reap identity changed before signal.")
                continue
            fresh, _ = self.fresh_enrolled_identity(process_identifier, leader_identifier)
            if not same_identity(current, fresh) or current["parentPid"] != fresh["parentPid"]:
                raise OwnershipRefusal("Current image changed before individual signal preparation.")
            if process_identifier == os.getpid():
                raise OwnershipRefusal("The reader cannot signal itself.")
            self.verify_owner()
            final = self.kernel.identity(process_identifier)
            if final is None:
                continue
            if (
                not same_identity(fresh, final) or final["status"] == 5
                or fresh["parentPid"] != final["parentPid"]
            ):
                raise OwnershipRefusal("Current identity changed immediately before individual signal.")
            expected["observedCurrentIdentity"] = {**final, "argv": list(final["argv"])}
            try:
                self.signal_process(process_identifier, getattr(signal, signal_name))
            except ProcessLookupError:
                if self.kernel.basic(process_identifier) is not None:
                    raise OwnershipRefusal("Signal target lookup failed while still present.")
            except OSError as failure:
                raise OwnershipRefusal("Verified individual task signal failed: " + str(failure)) from failure
            else:
                signaled.append(process_identifier)
        after = self.discover(leader_identifier, strict=True)
        return {**after, "individualSignals": signaled}

    def observed(self, process_identifier, signal_name=None):
        process_identifier = identifier(process_identifier)
        current = self.kernel.identity(process_identifier)
        if current is None:
            return {"state": "closed", "pid": process_identifier}
        expected = self.history.get(process_identifier)
        if expected is None:
            raise OwnershipRefusal("Observed live process has no immutable launched-group enrollment.")
        leader_identifier = expected["leaderPid"]
        self.discover(leader_identifier, strict=True)
        if current["status"] == 5:
            if not same_basic(expected["identity"], current):
                raise OwnershipRefusal("Observed pending-reap incarnation changed.")
            return {"state": "live", "pid": process_identifier}
        fresh, _ = self.fresh_enrolled_identity(process_identifier, leader_identifier)
        if not same_identity(current, fresh) or current["parentPid"] != fresh["parentPid"]:
            raise OwnershipRefusal("Observed current image changed during fresh inspection.")
        if signal_name is None:
            return {"state": "live", "pid": process_identifier}
        if signal_name not in ("SIGTERM", "SIGKILL"):
            raise OwnershipRefusal("Unsupported individual descendant signal.")
        if process_identifier == os.getpid():
            raise OwnershipRefusal("The reader cannot signal itself.")
        self.verify_owner()
        final = self.kernel.identity(process_identifier)
        if final is None:
            return {"state": "closed", "pid": process_identifier}
        if (
            not same_identity(fresh, final) or final["status"] == 5
            or fresh["parentPid"] != final["parentPid"]
        ):
            raise OwnershipRefusal("Observed process changed immediately before individual signal.")
        expected["observedCurrentIdentity"] = {**final, "argv": list(final["argv"])}
        try:
            self.signal_process(process_identifier, getattr(signal, signal_name))
        except ProcessLookupError:
            if self.kernel.basic(process_identifier) is not None:
                raise OwnershipRefusal("Observed signal target remains present after failed lookup.")
        except OSError as failure:
            raise OwnershipRefusal("Verified descendant signal failed: " + str(failure)) from failure
        return {"state": "signaled", "pid": process_identifier}

    def all_closed(self):
        for group_identifier in self.groups:
            if self.kernel.members(group_identifier):
                raise OwnershipRefusal("A launched task group still has live or pending members.")
        return {"state": "closed", "groups": len(self.groups), "enrollmentHistory": list(self.history.values())}


def serve(owner_identifier):
    kernel = KernelReader()
    ledger = OwnershipLedger(kernel, owner_identifier)
    reader_identity = kernel.identity(os.getpid())
    if (
        reader_identity is None or reader_identity["parentPid"] != owner_identifier
        or reader_identity["userId"] != ledger.owner["userId"]
        or reader_identity["pgid"] != os.getpid()
    ):
        raise OwnershipRefusal("The persistent reader is not a freshly launched owned child.")
    expected_sequence = 1
    while True:
        content = sys.stdin.buffer.readline(MAXIMUM_PACKET_BYTES + 1)
        if not content:
            return
        if not content.endswith(b"\n"):
            raise OwnershipRefusal("Partial process owner request ended before its line boundary.")
        if len(content) > MAXIMUM_PACKET_BYTES:
            raise OwnershipRefusal("Process owner request exceeded its packet bound.")
        request = json.loads(content)
        sequence = request.get("sequence")
        if type(sequence) is not int or sequence != expected_sequence or not 0 < sequence <= MAXIMUM_REQUESTS:
            raise OwnershipRefusal("Invalid process owner request sequence.")
        expected_sequence += 1
        operation = request.get("operation")
        stop = False
        try:
            ledger.verify_owner()
            if not same_identity(reader_identity, kernel.identity(os.getpid())):
                raise OwnershipRefusal("Persistent reader identity changed.")
            if operation == "hello":
                result = {"state": "ready", "ownerIdentity": ledger.owner, "readerIdentity": reader_identity}
            elif operation == "enroll":
                result = ledger.enroll(request["pid"], request["launchedMicroseconds"])
            elif operation == "discover":
                result = ledger.discover(request["leaderPid"], strict=False)
            elif operation == "signal-group":
                result = ledger.signal_group(request["leaderPid"], request["signal"])
            elif operation == "probe-observed":
                result = ledger.observed(request["pid"])
            elif operation == "signal-observed":
                result = ledger.observed(request["pid"], request["signal"])
            elif operation == "shutdown":
                result = ledger.all_closed()
                stop = True
            else:
                raise OwnershipRefusal("Unknown bounded process owner operation.")
            ledger.verify_owner()
            if not same_identity(reader_identity, kernel.identity(os.getpid())):
                raise OwnershipRefusal("Persistent reader changed before its response.")
            response = {"version": 1, "sequence": sequence, "ok": True, "result": result}
        except (OwnershipRefusal, OSError, ValueError, KeyError) as failure:
            response = {"version": 1, "sequence": sequence, "ok": False, "error": str(failure)}
        encoded = (json.dumps(response, ensure_ascii=True, separators=(",", ":")) + "\n").encode()
        if len(encoded) > MAXIMUM_PACKET_BYTES:
            encoded = (json.dumps({"version": 1, "sequence": sequence, "ok": False, "error": "Process owner response exceeded its packet bound."}) + "\n").encode()
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
        if stop:
            return


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--owner-pid":
        raise OwnershipRefusal("Expected one explicit launching host owner PID.")
    serve(identifier(int(sys.argv[2])))
