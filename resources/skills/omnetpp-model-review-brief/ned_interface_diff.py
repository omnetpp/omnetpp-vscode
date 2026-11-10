#!/usr/bin/env python3
"""
Mechanical diff of the NED-level external interface between two git revisions
of an OMNeT++ project.

Both revisions are extracted with `git archive` (the working tree is never
touched), parsed with `opp_nedtool convert -x`, flattened along `extends`
chains, and compared:

  - types added / removed / moved to another package / rename candidates
  - per type: base type, implemented interfaces, @class, parameters
    (type, effective value, default vs. fixed, unit, volatile, mutable,
    the type in the inheritance chain that declares / assigns it),
    deep (pattern) assignments, gates, submodules (type, like-expression,
    condition, vector size, declaring type), @signal and @statistic
  - module-tree paths: for every compound type, the expanded submodule tree;
    submodules that changed path (moved one level up/down into another
    compound, renamed) are reported where the change is introduced, not
    repeated in every type that contains it

External NED folders (e.g. INET) given with --external are parsed from the
file system and used only to resolve base types; they are not diffed.

Usage:
  ned_interface_diff.py BASE TIP [--repo DIR] [--folders F ...]
                        [--external DIR ...] [--json OUT.json]

BASE and TIP are any git revisions. NED folders default to the contents of
.nedfolders at each revision (excluding .nedexclusions packages).
Output: Markdown on stdout.
"""

import argparse
import difflib
import json
import os
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections import defaultdict

TYPE_TAGS = {"simple-module", "compound-module", "module-interface",
             "channel", "channel-interface"}
IGNORED_PROPS = {"display", "group", "labels", "defaultname"}


# ---------------------------------------------------------------- parsing

def run(cmd, cwd=None, check=True):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd)}\n{r.stderr}")
    return r


def extract_rev(repo, rev, dest):
    """Extract the tree of `rev` into `dest` without touching the work tree."""
    os.makedirs(dest, exist_ok=True)
    p1 = subprocess.Popen(["git", "-C", repo, "archive", rev], stdout=subprocess.PIPE)
    p2 = subprocess.run(["tar", "-x", "-C", dest], stdin=p1.stdout)
    p1.wait()
    if p1.returncode != 0 or p2.returncode != 0:
        sys.exit(f"cannot extract revision {rev}")


def ned_folders(root, override):
    if override:
        return override
    f = os.path.join(root, ".nedfolders")
    if not os.path.exists(f):
        return ["."]
    return [l.strip() for l in open(f) if l.strip() and not l.startswith("#")]


def ned_exclusions(root):
    f = os.path.join(root, ".nedexclusions")
    if not os.path.exists(f):
        return []
    return [l.strip() for l in open(f) if l.strip() and not l.startswith("#")]


def nedtool_xml(root, folders, scratch, tag):
    folders = [f for f in folders if os.path.isdir(os.path.join(root, f))]
    out = os.path.join(scratch, f"{tag}.xml")
    r = run(["opp_nedtool", "c", "-x", "-m", "-l", "-o", out] + folders,
            cwd=root, check=False)
    if r.returncode != 0 or not os.path.exists(out):
        sys.exit(f"opp_nedtool failed for {tag}:\n{r.stderr}")
    if r.stderr.strip():
        print(f"<!-- opp_nedtool ({tag}): {r.stderr.strip()} -->")
    return ET.parse(out).getroot()


def prop_value(el):
    """Serialize a property's keys as `key=v1,v2;key2=...` (stable order)."""
    parts = []
    for k in el.findall("property-key"):
        vals = ",".join(l.get("value", l.get("text", "")) for l in k.findall("literal"))
        parts.append(f"{k.get('name', '')}={vals}" if k.get("name") else vals)
    return ";".join(parts)


def loc(el):
    return el.get("src-loc", "")


def doc_of(el):
    """Normalized text of the comments attached to an element."""
    text = " ".join(c.get("content", "") for c in el.findall("comment"))
    return " ".join(w for w in re.sub(r"//+", " ", text).split())


class NedType:
    def __init__(self, kind, fqn, pkg, file, imports, el):
        self.kind = kind
        self.fqn = fqn
        self.pkg = pkg
        self.file = file
        self.imports = imports
        self.loc = loc(el)
        self.doc = doc_of(el)
        self.extends = [e.get("name") for e in el.findall("extends")]
        self.interfaces = [e.get("name") for e in el.findall("interface-name")]
        self.props = {}        # name[index] -> value
        self.params = {}       # name -> dict
        self.patterns = {}     # pattern -> dict
        self.gates = {}        # name -> dict
        self.submods = {}      # name -> dict
        self.connections = set()
        for params in el.findall("parameters"):
            self._read_params(params, self.params, self.patterns, self.props)
        for gates in el.findall("gates"):
            for g in gates.findall("gate"):
                self.gates[g.get("name")] = {
                    "type": g.get("type"), "vector": g.get("is-vector") == "true",
                    "size": g.get("vector-size"), "loc": loc(g)}
        for subs in el.findall("submodules"):
            for s in subs.findall("submodule"):
                cond = s.find("condition")
                sp, spat = {}, {}
                for params in s.findall("parameters"):
                    self._read_params(params, sp, spat, {})
                self.submods[s.get("name")] = {
                    "type": s.get("type"), "like": s.get("like-type"),
                    "likeExpr": s.get("like-expr"),
                    "likeDefault": s.get("is-default") == "true",
                    "vector": s.get("vector-size"),
                    "cond": cond.get("condition") if cond is not None else None,
                    "params": sp, "patterns": spat, "loc": loc(s)}
        for conns in el.findall("connections"):
            for c in conns.iter("connection"):
                self.connections.add(self._conn_str(c))

    @staticmethod
    def _read_params(params, out, patterns, props):
        for p in params.findall("param"):
            unit = mutable = None
            for pr in p.findall("property"):
                if pr.get("name") == "unit":
                    unit = prop_value(pr)
                elif pr.get("name") == "mutable":
                    mutable = True
            d = {"type": p.get("type"), "value": p.get("value"),
                 "isDefault": p.get("is-default") == "true",
                 "volatile": p.get("is-volatile") == "true",
                 "unit": unit, "mutable": bool(mutable), "loc": loc(p),
                 "doc": doc_of(p)}
            (patterns if p.get("is-pattern") == "true" else out)[p.get("name")] = d
        for pr in params.findall("property"):
            name = pr.get("name")
            if name in IGNORED_PROPS:
                continue
            key = f"{name}[{pr.get('index')}]" if pr.get("index") else name
            props[key] = {"value": prop_value(pr), "loc": loc(pr)}

    @staticmethod
    def _conn_str(c):
        def end(prefix):
            m = c.get(f"{prefix}-module", "")
            mi = c.get(f"{prefix}-module-index")
            g = c.get(f"{prefix}-gate", "")
            gi = c.get(f"{prefix}-gate-index")
            pp = "++" if c.get(f"{prefix}-gate-plusplus") == "true" else ""
            s = (m + (f"[{mi}]" if mi else "") + "." if m else "") + g
            return s + (f"[{gi}]" if gi else "") + pp
        arrow = "<-->" if c.get("is-bidirectional") == "true" else "-->"
        a, b = end("src"), end("dest")
        if c.get("is-forward-arrow") == "false":
            a, b = b, a
            arrow = "<--" if arrow == "-->" else arrow
        return f"{a} {arrow} {b}"


def collect_types(root_el, exclusions=()):
    types = {}
    for f in root_el.findall("ned-file"):
        fname = f.get("filename", "").lstrip("./")
        pkg_el = f.find("package")
        pkg = pkg_el.get("name") if pkg_el is not None else ""
        if any(pkg == x or pkg.startswith(x + ".") for x in exclusions):
            continue
        imports = [i.get("import-spec") for i in f.findall("import")]

        def walk(el, prefix):
            for t in el:
                if t.tag in TYPE_TAGS:
                    name = prefix + t.get("name")
                    fqn = f"{pkg}.{name}" if pkg else name
                    types[fqn] = NedType(t.tag, fqn, pkg, fname, imports, t)
                    for inner in t.findall("types"):
                        walk(inner, name + ".")
        walk(f, "")
    return types


# ----------------------------------------------------------- resolution

class Model:
    def __init__(self, types, external):
        self.types = types
        self.all = dict(external)
        self.all.update(types)
        self.by_short = defaultdict(list)
        for fqn in self.all:
            self.by_short[fqn.rsplit(".", 1)[-1]].append(fqn)
        self._flat = {}
        self._tree = {}

    def resolve(self, name, ctx):
        if not name:
            return None
        if name in self.all:
            return name
        if "." in name:
            return None
        t = self.all.get(ctx)
        if t is not None:
            # inner types of the enclosing type
            if f"{ctx}.{name}" in self.all:
                return f"{ctx}.{name}"
            for imp in t.imports:
                if imp.rsplit(".", 1)[-1] == name and imp in self.all:
                    return imp
                if imp.endswith(".*") or "*" in imp:
                    rx = re.compile("^" + re.escape(imp).replace(r"\*\*", ".*")
                                    .replace(r"\*", r"[^.]*") + "$")
                    cand = [f for f in self.by_short[name] if rx.match(f)]
                    if len(cand) == 1:
                        return cand[0]
            same = f"{t.pkg}.{name}" if t.pkg else name
            if same in self.all:
                return same
        cand = self.by_short[name]
        return cand[0] if len(cand) == 1 else None

    def flat(self, fqn, _seen=None):
        """Effective interface of a type, with inherited members."""
        if fqn in self._flat:
            return self._flat[fqn]
        t = self.all[fqn]
        _seen = (_seen or set()) | {fqn}
        res = {"params": {}, "patterns": {}, "gates": {}, "submods": {},
               "props": {}, "connections": set(), "chain": [fqn],
               "interfaces": set()}
        if t.kind in ("simple-module", "compound-module", "channel"):
            bases = t.extends[:1]
        else:
            bases = t.extends   # interfaces may extend several
        for b in bases:
            bf = self.resolve(b, fqn)
            if bf is None or bf in _seen:
                res["chain"].append(f"?{b}")
                continue
            base = self.flat(bf, _seen)
            for k in ("params", "patterns", "gates", "submods", "props"):
                for n, v in base[k].items():
                    res[k][n] = dict(v)
            res["connections"] |= base["connections"]
            res["chain"] += base["chain"]
            res["interfaces"] |= base["interfaces"]
        for i in t.interfaces:
            res["interfaces"].add(self.resolve(i, fqn) or f"?{i}")
        for n, p in t.params.items():
            if p["type"] is None and n in res["params"]:
                q = res["params"][n]
                q.update(value=p["value"], isDefault=p["isDefault"],
                         assignedIn=fqn, loc=p["loc"])
            else:
                res["params"][n] = dict(p, declaredIn=fqn, assignedIn=fqn)
        for n, p in t.patterns.items():
            res["patterns"][n] = dict(p, assignedIn=fqn)
        for n, g in t.gates.items():
            if g["type"] is None and n in res["gates"]:
                res["gates"][n]["size"] = g["size"]
            else:
                res["gates"][n] = dict(g, declaredIn=fqn)
        for n, s in t.submods.items():
            r = dict(s, declaredIn=fqn)
            r["typeFqn"] = self.resolve(s["type"], fqn) if s["type"] else None
            r["likeFqn"] = self.resolve(s["like"], fqn) if s["like"] else None
            res["submods"][n] = r
        for n, p in t.props.items():
            res["props"][n] = dict(p, declaredIn=fqn)
        res["connections"] |= t.connections
        self._flat[fqn] = res
        return res

    def submod_type(self, owner, s):
        """Concrete type of a submodule when statically known."""
        if s.get("typeFqn"):
            return s["typeFqn"]
        expr = s.get("likeExpr") or ""
        m = re.fullmatch(r'\s*"([\w.]+)"\s*', expr)
        if m:
            return self.resolve(m.group(1), owner)
        tn = s["params"].get("typename")
        if tn and tn["value"]:
            m = re.fullmatch(r'\s*"([\w.]+)"\s*', tn["value"])
            if m:
                return self.resolve(m.group(1), owner)
        return None

    def tree(self, fqn, depth=0, _seen=frozenset()):
        """Expanded submodule tree: relative path -> type label."""
        if fqn in self._tree:
            return self._tree[fqn]
        out = {}
        if depth > 12 or fqn in _seen or fqn not in self.all:
            return out
        f = self.flat(fqn)
        for n, s in f["submods"].items():
            name = n + ("[]" if s["vector"] else "")
            ct = self.submod_type(fqn, s)
            label = ct or (f"like {s['likeFqn'] or s['like']}" if s["like"]
                           else f"?{s['type']}")
            out[name] = label
            if ct and self.all[ct].kind == "compound-module":
                for p, l in self.tree(ct, depth + 1, _seen | {fqn}).items():
                    out[f"{name}.{p}"] = l
        self._tree[fqn] = out
        return out


# ----------------------------------------------------------------- diff

def short(fqn):
    return fqn.rsplit(".", 1)[-1] if fqn else str(fqn)


def fmt_param(p):
    if p is None:
        return "-"
    v = p["value"]
    t = p["type"] or ""
    if v is None:
        val = "(no value: must be set)"
    elif p["isDefault"]:
        val = f"default({v})"
    else:
        val = f"= {v} (FIXED)"
    extras = []
    if p.get("unit"):
        extras.append(f"@unit({p['unit']})")
    if p.get("volatile"):
        extras.append("volatile")
    if p.get("mutable"):
        extras.append("@mutable")
    return " ".join(x for x in [t, val] + extras if x)


def jaccard(a, b):
    a, b = set(a), set(b)
    return len(a & b) / len(a | b) if a | b else 1.0


def diff_members(old, new, describe, same_key):
    """Generic keyed diff: returns (removed, added, changed, renames)."""
    removed = {k: v for k, v in old.items() if k not in new}
    added = {k: v for k, v in new.items() if k not in old}
    renames = []
    for rk, rv in list(removed.items()):
        cands = [ak for ak, av in added.items() if same_key(rv, av)]
        if len(cands) == 1:
            renames.append((rk, cands[0]))
            del removed[rk]
            del added[cands[0]]
    changed = {k: (old[k], new[k]) for k in old.keys() & new.keys()
               if describe(old[k]) != describe(new[k])}
    return removed, added, changed, renames


def type_diff(ob, nb, fqn):
    """Bulleted findings for one type present in both revisions."""
    o, n = ob.flat(fqn), nb.flat(fqn)
    ot, nt = ob.all[fqn], nb.all[fqn]
    lines = []
    if ot.doc != nt.doc:
        lines.append(f"type doc comment CHANGED ({len(ot.doc.split())} -> "
                     f"{len(nt.doc.split())} words): read it -- a meaning may have "
                     f"changed without a declaration change")
    if ot.kind != nt.kind:
        lines.append(f"kind: {ot.kind} -> {nt.kind}")
    ochain, nchain = [short(x) for x in o["chain"][1:]], [short(x) for x in n["chain"][1:]]
    if ochain != nchain:
        lines.append(f"inheritance: {' < '.join(ochain) or '(none)'} -> "
                     f"{' < '.join(nchain) or '(none)'}")
    if o["interfaces"] != n["interfaces"]:
        lines.append(f"implements: {sorted(map(short, o['interfaces']))} -> "
                     f"{sorted(map(short, n['interfaces']))}")

    # parameters
    rm, ad, ch, rn = diff_members(
        o["params"], n["params"], fmt_param,
        lambda a, b: a["type"] == b["type"] and a["value"] == b["value"]
        and a["value"] is not None)
    for k, v in sorted(rm.items()):
        lines.append(f"param REMOVED: `{k}` [{fmt_param(v)}]")
    for k, v in sorted(ad.items()):
        tag = "param ADDED (no default: every config must set it)" \
            if v["value"] is None else "param ADDED"
        lines.append(f"{tag}: `{k}` [{fmt_param(v)}] ({v['loc']})")
    for a, b in rn:
        lines.append(f"param RENAMED? `{a}` -> `{b}` [{fmt_param(n['params'][b])}] "
                     f"({n['params'][b]['loc']})")
    for k, (a, b) in sorted(ch.items()):
        lines.append(f"param CHANGED: `{k}`: {fmt_param(a)} -> {fmt_param(b)} ({b['loc']})")
    for k in sorted(o["params"].keys() & n["params"].keys()):
        a, b = o["params"][k], n["params"][k]
        if short(a["declaredIn"]) != short(b["declaredIn"]):
            lines.append(f"param `{k}` now DECLARED in {short(b['declaredIn'])} "
                         f"(was {short(a['declaredIn'])})")
        elif a["assignedIn"] != b["assignedIn"] and fmt_param(a) == fmt_param(b):
            lines.append(f"param `{k}` value now set in {short(b['assignedIn'])} "
                         f"(was {short(a['assignedIn'])})")

    for k in sorted(o["params"].keys() & n["params"].keys()):
        a, b = o["params"][k].get("doc", ""), n["params"][k].get("doc", "")
        if a != b and short(o["params"][k]["declaredIn"]) == short(n["params"][k]["declaredIn"]):
            lines.append(f"param `{k}` comment CHANGED: \"{a}\" -> \"{b}\"")

    # deep assignments
    pv = lambda p: f"{'default(' + p['value'] + ')' if p['isDefault'] else '= ' + str(p['value'])}"
    for k in sorted(o["patterns"].keys() - n["patterns"].keys()):
        lines.append(f"deep assignment REMOVED: `{k}` {pv(o['patterns'][k])}")
    for k in sorted(n["patterns"].keys() - o["patterns"].keys()):
        lines.append(f"deep assignment ADDED: `{k}` {pv(n['patterns'][k])} "
                     f"({n['patterns'][k]['loc']})")
    for k in sorted(o["patterns"].keys() & n["patterns"].keys()):
        if pv(o["patterns"][k]) != pv(n["patterns"][k]):
            lines.append(f"deep assignment CHANGED: `{k}` {pv(o['patterns'][k])} -> "
                         f"{pv(n['patterns'][k])}")

    # gates
    gd = lambda g: f"{g['type']}{'[]' if g['vector'] else ''}"
    rm, ad, ch, rn = diff_members(o["gates"], n["gates"], gd,
                                  lambda a, b: gd(a) == gd(b))
    for k, v in sorted(rm.items()):
        lines.append(f"gate REMOVED: `{k}` ({gd(v)})")
    for k, v in sorted(ad.items()):
        lines.append(f"gate ADDED: `{k}` ({gd(v)})")
    for a, b in rn:
        lines.append(f"gate RENAMED? `{a}` -> `{b}`")
    for k, (a, b) in sorted(ch.items()):
        lines.append(f"gate CHANGED: `{k}`: {gd(a)} -> {gd(b)}")
    for k in sorted(o["gates"].keys() & n["gates"].keys()):
        if short(o["gates"][k]["declaredIn"]) != short(n["gates"][k]["declaredIn"]):
            lines.append(f"gate `{k}` now DECLARED in {short(n['gates'][k]['declaredIn'])} "
                         f"(was {short(o['gates'][k]['declaredIn'])})")

    # submodules
    def sd(s, model, owner):
        t = model.submod_type(owner, s)
        d = short(t) if t else (f"like {short(s['likeFqn'] or s['like'])}"
                                if s["like"] else f"?{s['type']}")
        if s["like"] and s["likeExpr"]:
            d += f" <{'default ' if s['likeDefault'] else ''}{s['likeExpr']}>"
        if s["vector"]:
            d += f" [{s['vector']}]"
        if s["cond"]:
            d += f" if {s['cond']}"
        return d
    os_, ns_ = o["submods"], n["submods"]
    gone = {k: sd(os_[k], ob, fqn) for k in os_.keys() - ns_.keys()}
    new_ = {k: sd(ns_[k], nb, fqn) for k in ns_.keys() - os_.keys()}
    for k, d in sorted(gone.items()):
        cands = [a for a, ad in new_.items() if ad == d]
        if len(cands) == 1 and [g for g, gd_ in gone.items() if gd_ == d] == [k]:
            lines.append(f"submodule RENAMED? `{k}` -> `{cands[0]}`: {d} "
                         f"({ns_[cands[0]]['loc']})")
            del new_[cands[0]]
        else:
            lines.append(f"submodule REMOVED: `{k}`: {d}")
    for k, d in sorted(new_.items()):
        lines.append(f"submodule ADDED: `{k}`: {d} ({ns_[k]['loc']})")
    for k in sorted(os_.keys() & ns_.keys()):
        a, b = sd(os_[k], ob, fqn), sd(ns_[k], nb, fqn)
        if a != b:
            lines.append(f"submodule CHANGED: `{k}`: {a} -> {b} ({ns_[k]['loc']})")
        if short(os_[k]["declaredIn"]) != short(ns_[k]["declaredIn"]):
            lines.append(f"submodule `{k}` now DECLARED in {short(ns_[k]['declaredIn'])} "
                         f"(was {short(os_[k]['declaredIn'])})")
        oa = {p: fmt_param(v) for p, v in os_[k]["params"].items()}
        na = {p: fmt_param(v) for p, v in ns_[k]["params"].items()}
        oa.update({p: pv(v) for p, v in os_[k]["patterns"].items()})
        na.update({p: pv(v) for p, v in ns_[k]["patterns"].items()})
        for p in sorted(oa.keys() | na.keys()):
            if oa.get(p) != na.get(p):
                lines.append(f"submodule `{k}` assignment `{p}`: "
                             f"{oa.get(p, '-')} -> {na.get(p, '-')}")

    # properties: @class, @signal, @statistic, others
    for k in sorted(o["props"].keys() | n["props"].keys()):
        a, b = o["props"].get(k), n["props"].get(k)
        if a is None:
            lines.append(f"@{k} ADDED: {b['value']}")
        elif b is None:
            lines.append(f"@{k} REMOVED (was {a['value']})")
        elif a["value"] != b["value"]:
            lines.append(f"@{k} CHANGED: {a['value']} -> {b['value']}")

    # connections (own type only, to avoid repeating inherited ones)
    oc, nc = ot.connections, nt.connections
    if oc != nc:
        lines.append(f"connections: {len(oc - nc)} removed, {len(nc - oc)} added")
        for c in sorted(oc - nc):
            lines.append(f"  - `{c}`")
        for c in sorted(nc - oc):
            lines.append(f"  + `{c}`")
    return lines


def tree_changes(ob, nb, fqn, cache):
    """Path-level changes of a compound's expanded tree.

    Returns (all_paths, reported): `all_paths` is every changed relative path
    (used by containing types to recognize changes they merely contain);
    `reported` lists (kind, text) for the changes introduced by this type
    itself, with descendants of added/removed subtrees collapsed."""
    if fqn in cache:
        return cache[fqn]
    cache[fqn] = (set(), [])      # cycle guard
    ot, nt = ob.tree(fqn), nb.tree(fqn)
    removed = {p: t for p, t in ot.items() if p not in nt}
    added = {p: t for p, t in nt.items() if p not in ot}
    retyped = {p: (ot[p], nt[p]) for p in ot.keys() & nt.keys()
               if short(ot[p]) != short(nt[p])}
    all_paths = set(removed) | set(added) | set(retyped)

    def explained(path):
        head, _, rest = path.partition(".")
        if not rest:
            return False
        name = head[:-2] if head.endswith("[]") else head
        so = ob.flat(fqn)["submods"].get(name)
        sn = nb.flat(fqn)["submods"].get(name)
        if not so or not sn:
            return True     # the head itself changed: reported at the head
        to, tn = ob.submod_type(fqn, so), nb.submod_type(fqn, sn)
        if not to or not tn or short(to) != short(tn):
            return True     # retyped head: reported at the head
        if to == tn and to in nb.types:
            return rest in tree_changes(ob, nb, to, cache)[0]
        return False

    def under(path, roots):
        return any(path.startswith(r + ".") for r in roots)

    reported = []
    # same type vanished from one path and appeared at another: move/rename
    by_type_r, by_type_a = defaultdict(list), defaultdict(list)
    for p, t in removed.items():
        by_type_r[short(t)].append(p)
    for p, t in added.items():
        by_type_a[short(t)].append(p)
    for t in set(by_type_r) & set(by_type_a):
        if len(by_type_r[t]) == 1 and len(by_type_a[t]) == 1:
            a, b = by_type_r[t][0], by_type_a[t][0]
            if not (explained(a) and explained(b)):
                kind = "RENAMED" if a.rpartition(".")[0] == b.rpartition(".")[0] \
                    else "MOVED"
                reported.append((kind, f"{a} -> {b} ({t})"))
            # the subtree moves along with it
            for p in [p for p in removed if p.startswith(a + ".")]:
                del removed[p]
            for p in [p for p in added if p.startswith(b + ".")]:
                del added[p]
            del removed[a]
            del added[b]
    for p, t in sorted(removed.items()):
        if not under(p, removed) and not explained(p):
            reported.append(("GONE", f"{p} ({short(t)})"))
    for p, t in sorted(added.items()):
        if not under(p, added) and not explained(p):
            reported.append(("NEW", f"{p} ({short(t)})"))
    for p, (a, b) in sorted(retyped.items()):
        if not explained(p):
            reported.append(("RETYPED", f"{p}: {short(a)} -> {short(b)}"))
    cache[fqn] = (all_paths, reported)
    return cache[fqn]


def type_signature(model, fqn):
    f = model.flat(fqn)
    return set(f["params"]) | {"g:" + g for g in f["gates"]} | \
        {"s:" + s for s in f["submods"]}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("base")
    ap.add_argument("tip")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--folders", nargs="*", help="NED folders (default: .nedfolders)")
    ap.add_argument("--external", nargs="*", default=[],
                    help="NED folders used only for base-type resolution (e.g. INET's src)")
    ap.add_argument("--json", help="also write the raw findings as JSON")
    args = ap.parse_args()

    repo = os.path.abspath(args.repo)
    revs = {}
    for tag, rev in (("base", args.base), ("tip", args.tip)):
        r = run(["git", "-C", repo, "log", "-1", "--format=%h %s", rev])
        revs[tag] = r.stdout.strip()

    with tempfile.TemporaryDirectory() as scratch:
        external = {}
        for i, d in enumerate(args.external):
            ext = nedtool_xml(os.path.abspath(d), ["."], scratch, f"ext{i}")
            external.update(collect_types(ext))
        models = {}
        for tag, rev in (("base", args.base), ("tip", args.tip)):
            root = os.path.join(scratch, tag)
            extract_rev(repo, rev, root)
            xml = nedtool_xml(root, ned_folders(root, args.folders), scratch, tag)
            models[tag] = Model(collect_types(xml, ned_exclusions(root)), external)

    ob, nb = models["base"], models["tip"]
    old, new = set(ob.types), set(nb.types)
    removed, added = old - new, new - old

    moved, renamed = [], []
    for r in sorted(removed):
        same = [a for a in added if short(a) == short(r)]
        if len(same) == 1:
            moved.append((r, same[0]))
    for r, a in moved:
        removed.discard(r)
        added.discard(a)
    # rename candidates: one-to-one, best member overlap first, name
    # similarity as tie breaker
    scored = sorted(
        ((jaccard(type_signature(ob, r), type_signature(nb, a)),
          difflib.SequenceMatcher(None, short(r), short(a)).ratio(), r, a)
         for r in removed for a in added if nb.all[a].kind == ob.all[r].kind),
        reverse=True)
    for sim, _, r, a in scored:
        if sim >= 0.6 and r in removed and a in added:
            renamed.append((r, a, sim))
            removed.discard(r)
            added.discard(a)

    out = [f"# NED interface diff",
           f"", f"- base: {revs['base']}", f"- tip:  {revs['tip']}",
           f"- types: {len(old)} -> {len(new)}", ""]
    report = {"base": revs["base"], "tip": revs["tip"], "types": {}}

    def section(title, items):
        if items:
            out.append(f"## {title}")
            out.append("")
            out.extend(items)
            out.append("")

    section("Types removed", [f"- `{r}` ({ob.all[r].kind}, {ob.all[r].loc})"
                              for r in sorted(removed)])
    section("Types added", [f"- `{a}` ({nb.all[a].kind}, {nb.all[a].loc})"
                            for a in sorted(added)])
    section("Types moved to another package",
            [f"- `{r}` -> `{a}`" for r, a in moved])
    section("Type rename candidates (same kind, similar members -- verify)",
            [f"- `{r}` -> `{a}` (member overlap {s:.0%})" for r, a, s in renamed])

    pairs = [(f, f) for f in sorted(old & new)] + moved + [(r, a) for r, a, _ in renamed]
    raw = {}
    for of, nf in pairs:
        raw[nf] = type_diff(ob, nb, nf) if of == nf else type_diff_renamed(ob, nb, of, nf)
    changed = []
    for of, nf in pairs:
        lines = suppress_inherited(ob, nb, nf, raw)
        if lines:
            changed.append((nf, lines))
            report["types"][nf] = lines
    only_inh = [(f, l[0]) for f, l in changed
                if len(l) == 1 and l[0].startswith("(also inherits")]
    changed = [(f, l) for f, l in changed
               if not (len(l) == 1 and l[0].startswith("(also inherits"))]
    if changed:
        out.append("## Changed types")
        out.append("")
        for fqn, lines in changed:
            t = nb.all[fqn]
            out.append(f"### {short(fqn)} ({t.kind}, `{t.file}`)")
            out.extend(l if l.startswith("  ") else f"- {l}" for l in lines)
            out.append("")

    section("Types affected only through inheritance",
            [f"- {short(f)}: {l.strip('()').replace('also inherits the changes of', 'from')}"
             for f, l in only_inh])

    cache = {}
    tree_lines = []
    for f in sorted(old & new):
        if nb.all[f].kind != "compound-module":
            continue
        ch = list(tree_changes(ob, nb, f, cache)[1])
        b = same_base(ob, nb, f)
        if b and ch:
            inherited = set(tree_changes(ob, nb, b, cache)[1])
            kept = [c for c in ch if c not in inherited]
            if not kept:
                continue
            if len(kept) < len(ch):
                kept.append(("INHERITED", f"also the changes of {short(b)}"))
            ch = kept
        if ch:
            tree_lines.append(f"### {short(f)}")
            tree_lines.extend(f"- {kind}: `{txt}`" for kind, txt in ch)
            tree_lines.append("")
            report.setdefault("trees", {})[f] = [f"{k}: {t}" for k, t in ch]
    section("Module-tree path changes (ini keys under these paths move)", tree_lines)

    if len(out) == 6:
        out.append("No NED interface changes found.")
    print("\n".join(out))
    if args.json:
        with open(args.json, "w") as fp:
            json.dump(report, fp, indent=1)


def same_base(ob, nb, fqn):
    """The direct base type, when it is the same type in both revisions."""
    if fqn not in ob.all or fqn not in nb.all:
        return None
    bo = ob.flat(fqn)["chain"][1:2]
    bn = nb.flat(fqn)["chain"][1:2]
    if bo and bo == bn and not bo[0].startswith("?") and bo[0] in nb.types:
        return bo[0]
    return None


def suppress_inherited(ob, nb, fqn, raw):
    """Drop findings a subtype merely inherits from an (unchanged-identity) base."""
    lines = raw.get(fqn, [])
    b = same_base(ob, nb, fqn)
    if not b or b not in raw:
        return lines
    inherited = set(raw[b])
    kept = [l for l in lines if l not in inherited]
    if len(kept) < len(lines):
        kept.append(f"(also inherits the changes of {short(b)})")
    return kept


def type_diff_renamed(ob, nb, of, nf):
    """Diff a type that was moved/renamed: alias the old fqn in the new model."""
    alias = Model.__new__(Model)
    alias.__dict__.update(ob.__dict__)
    alias._flat = dict(ob._flat)
    alias._tree = dict(ob._tree)
    alias.all = dict(ob.all)
    alias.all[nf] = ob.all[of]
    alias._flat.pop(nf, None)
    return type_diff(alias, nb, nf)


if __name__ == "__main__":
    main()
