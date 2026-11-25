//! Queryable snapshot tables. SQLite commits these rows with the exact editable JSON and journal.
use std::{borrow::Cow, collections::BTreeMap};

use rusqlite::{Connection, Transaction, params};
use serde_json::{Map, Value};

use super::{Res, msg, rank};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS nodes(
    id TEXT PRIMARY KEY NOT NULL, parent_id TEXT, order_key BLOB NOT NULL, text TEXT NOT NULL,
    node_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS nodes_by_parent ON nodes(parent_id, order_key);
CREATE TABLE IF NOT EXISTS edges(
    kind TEXT NOT NULL CHECK (kind IN ('child', 'link')),
    id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
    edge_json TEXT NOT NULL, PRIMARY KEY(kind, id));
CREATE INDEX IF NOT EXISTS edges_by_from ON edges(from_id);
CREATE INDEX IF NOT EXISTS edges_by_to ON edges(to_id);
CREATE TABLE IF NOT EXISTS styles(
    kind TEXT NOT NULL, owner_id TEXT NOT NULL, style_json TEXT NOT NULL,
    PRIMARY KEY(kind, owner_id));
CREATE TABLE IF NOT EXISTS ai_jobs(
    id TEXT PRIMARY KEY NOT NULL, job_json TEXT NOT NULL);";

struct Projection<'a> {
    nodes: &'a Map<String, Value>,
    edges: BTreeMap<(&'static str, &'a str), (&'a str, &'a str, Option<&'a Value>)>,
    styles: BTreeMap<(&'static str, &'a str), &'a Value>,
    jobs: Option<&'a Map<String, Value>>,
    order: BTreeMap<&'a str, usize>,
    sibling_lists: Vec<Vec<&'a str>>,
}

impl<'a> Projection<'a> {
    fn read(doc: &'a Value) -> Res<Self> {
        let Some(nodes) = doc["nodes"].as_object() else {
            return msg("The document has no node collection.");
        };
        let roots = doc["roots"].as_array().into_iter().flatten();
        let links = doc["links"].as_array().into_iter().flatten();
        let mut edges = BTreeMap::new();
        let mut styles = BTreeMap::new();
        let mut order = BTreeMap::new();
        let mut sibling_lists = vec![(None, roots.filter_map(Value::as_str).collect::<Vec<_>>())];
        for (id, node) in nodes {
            if let Some(parent) = node["parent"].as_str() {
                edges.insert(("child", id.as_str()), (parent, id.as_str(), None));
            }
            for (kind, field) in [
                ("node", "style"),
                ("generated", "generatedStyle"),
                ("art", "artStyleOverrides"),
                ("art_sheet", "artStyleSheet"),
            ] {
                if let Some(value) = node.get(field).filter(|value| !value.is_null()) {
                    styles.insert((kind, id.as_str()), value);
                }
            }
            if let Some(children) = node["children"]
                .as_array()
                .filter(|children| !children.is_empty())
            {
                sibling_lists.push((
                    Some(id.as_str()),
                    children.iter().filter_map(Value::as_str).collect(),
                ));
            }
        }
        for (parent, siblings) in &sibling_lists {
            for (i, id) in siblings.iter().enumerate() {
                if nodes
                    .get(*id)
                    .is_none_or(|node| node["parent"].as_str() != *parent)
                    || order.insert(*id, i).is_some()
                {
                    return msg("The document has an invalid sibling list.");
                }
            }
        }
        if order.len() != nodes.len() {
            return msg("The document has a node missing from its sibling list.");
        }
        for link in links {
            if let (Some(id), Some(from), Some(to)) = (
                link["id"].as_str(),
                link["from"].as_str(),
                link["to"].as_str(),
            ) {
                edges.insert(("link", id), (from, to, Some(link)));
            }
        }
        for (kind, field) in [
            ("theme", "themeId"),
            ("theme_settings", "themeSettings"),
            ("art_theme", "artStyleId"),
            ("tag_colors", "tagColors"),
            ("marker_meanings", "markerMeanings"),
        ] {
            if let Some(value) = doc.get(field).filter(|value| !value.is_null()) {
                styles.insert((kind, ""), value);
            }
        }
        Ok(Self {
            nodes,
            edges,
            styles,
            jobs: doc["aiJobs"].as_object(),
            order,
            sibling_lists: sibling_lists
                .into_iter()
                .map(|(_, siblings)| siblings)
                .collect(),
        })
    }
}

fn node_payload(node: &Value) -> Value {
    let mut value = node.clone();
    if let Some(fields) = value.as_object_mut() {
        fields.remove("children");
    }
    value
}

fn same_payload(left: &Value, right: &Value) -> bool {
    if left == right {
        return true;
    }
    let (Some(a), Some(b)) = (left.as_object(), right.as_object()) else {
        return false;
    };
    a.len() - usize::from(a.contains_key("children"))
        == b.len() - usize::from(b.contains_key("children"))
        && a.iter()
            .all(|(k, v)| k == "children" || b.get(k) == Some(v))
}

pub(super) type RankSeed = BTreeMap<String, (Option<String>, Vec<u8>)>;

pub(super) fn read_keys(connection: &Connection) -> Res<RankSeed> {
    let mut keys = RankSeed::new();
    let mut statement = connection.prepare("SELECT id,parent_id,order_key FROM nodes")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let key: Vec<u8> = row.get(2)?;
        if !rank::valid(&key) {
            return msg("The document has an invalid sibling order key.");
        }
        keys.insert(row.get(0)?, (row.get(1)?, key));
    }
    Ok(keys)
}

pub fn materialize(
    tx: &Transaction<'_>,
    doc: &Value,
    previous: Option<&Value>,
    seed: Option<&RankSeed>,
) -> Res<()> {
    tx.execute_batch(SCHEMA)?;
    let current = Projection::read(doc)?;
    let previous = previous.map(Projection::read).transpose()?;

    {
        let old_ranks = match seed {
            Some(seed) => Cow::Borrowed(seed),
            None if previous.is_some() => Cow::Owned(read_keys(tx)?),
            None => Cow::Owned(RankSeed::new()),
        };
        let mut upsert = tx.prepare("INSERT INTO nodes(id,parent_id,order_key,text,node_json) VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, order_key=excluded.order_key, text=excluded.text, node_json=excluded.node_json")?;
        let mut delete = tx.prepare("DELETE FROM nodes WHERE id=?1")?;
        for siblings in &current.sibling_lists {
            let keys = siblings
                .iter()
                .map(|id| {
                    let (parent, key) = old_ranks.get(*id)?;
                    (parent.as_deref() == current.nodes[*id]["parent"].as_str())
                        .then_some(key.as_slice())
                })
                .collect::<Vec<_>>();
            for (id, key) in siblings.iter().copied().zip(rank::assign(&keys)) {
                let node = &current.nodes[id];
                if previous
                    .as_ref()
                    .and_then(|p| p.nodes.get(id))
                    .is_some_and(|old| {
                        old_ranks
                            .get(id)
                            .is_some_and(|(_, old_key)| old_key == &key)
                            && same_payload(old, node)
                    })
                {
                    continue;
                }
                upsert.execute(params![
                    id,
                    node["parent"].as_str(),
                    key,
                    node["text"].as_str().unwrap_or(""),
                    node_payload(node).to_string()
                ])?;
            }
        }
        if let Some(prev) = &previous {
            for id in prev
                .nodes
                .keys()
                .filter(|id| !current.nodes.contains_key(*id))
            {
                delete.execute([id])?;
            }
        }
    }
    {
        let mut upsert = tx.prepare("INSERT INTO edges(kind,id,from_id,to_id,edge_json) VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(kind,id) DO UPDATE SET from_id=excluded.from_id, to_id=excluded.to_id, edge_json=excluded.edge_json")?;
        let mut delete = tx.prepare("DELETE FROM edges WHERE kind=?1 AND id=?2")?;
        for (key @ (kind, id), value @ (from, to, payload)) in &current.edges {
            if previous
                .as_ref()
                .is_some_and(|prev| prev.edges.get(key) == Some(value))
            {
                continue;
            }
            upsert.execute(params![
                kind,
                id,
                from,
                to,
                payload
                    .map(|p| p.to_string())
                    .unwrap_or_else(|| "{}".into())
            ])?;
        }
        if let Some(prev) = &previous {
            for (kind, id) in prev
                .edges
                .keys()
                .filter(|key| !current.edges.contains_key(key))
            {
                delete.execute(params![kind, id])?;
            }
        }
    }
    {
        let mut upsert = tx.prepare(
            "INSERT INTO styles(kind,owner_id,style_json) VALUES(?1,?2,?3)
            ON CONFLICT(kind,owner_id) DO UPDATE SET style_json=excluded.style_json",
        )?;
        let mut delete = tx.prepare("DELETE FROM styles WHERE kind=?1 AND owner_id=?2")?;
        for (key @ (kind, id), style) in &current.styles {
            if previous
                .as_ref()
                .is_some_and(|prev| prev.styles.get(key) == Some(style))
            {
                continue;
            }
            upsert.execute(params![kind, id, style.to_string()])?;
        }
        if let Some(prev) = &previous {
            for (kind, id) in prev
                .styles
                .keys()
                .filter(|key| !current.styles.contains_key(key))
            {
                delete.execute(params![kind, id])?;
            }
        }
    }
    {
        let mut upsert = tx.prepare("INSERT INTO ai_jobs(id,job_json) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET job_json=excluded.job_json")?;
        let mut delete = tx.prepare("DELETE FROM ai_jobs WHERE id=?1")?;
        for (id, job) in current.jobs.into_iter().flatten() {
            if previous
                .as_ref()
                .and_then(|prev| prev.jobs)
                .and_then(|jobs| jobs.get(id))
                == Some(job)
            {
                continue;
            }
            upsert.execute(params![id, job.to_string()])?;
        }
        for id in previous
            .and_then(|prev| prev.jobs)
            .into_iter()
            .flat_map(Map::keys)
        {
            if current.jobs.is_none_or(|jobs| !jobs.contains_key(id)) {
                delete.execute([id])?;
            }
        }
    }
    Ok(())
}

pub fn verify(connection: &Connection, value: &Value, fractional: bool) -> Res<()> {
    let doc = Projection::read(value)?;
    for (table, expected) in [
        ("nodes", doc.nodes.len()),
        ("edges", doc.edges.len()),
        ("styles", doc.styles.len()),
        ("ai_jobs", doc.jobs.map_or(0, Map::len)),
    ] {
        let count: i64 =
            connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })?;
        if count as usize != expected {
            return msg(format!("The document has an inconsistent {table} table."));
        }
    }
    let sql = if fractional {
        "SELECT id,parent_id,order_key,text,node_json FROM nodes ORDER BY parent_id,order_key"
    } else {
        "SELECT id,parent_id,ordinal,text,node_json FROM nodes"
    };
    let mut nodes = connection.prepare(sql)?;
    let mut rows = nodes.query([])?;
    let mut parents = BTreeMap::<Option<String>, (usize, Vec<u8>)>::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let Some(node) = doc.nodes.get(&id) else {
            return msg("The document has an unexpected node row.");
        };
        let parent: Option<String> = row.get(1)?;
        let text: String = row.get(3)?;
        let payload: Value = serde_json::from_str(&row.get::<_, String>(4)?)?;
        let matches_order = if fractional {
            let key: Vec<u8> = row.get(2)?;
            let (ordinal, previous) = parents.entry(parent.clone()).or_default();
            let matches =
                rank::valid(&key) && *previous < key && doc.order.get(id.as_str()) == Some(ordinal);
            *previous = key;
            *ordinal += 1;
            matches
        } else {
            row.get::<_, Option<i64>>(2)? == doc.order.get(id.as_str()).map(|i| *i as i64)
        };
        let matches_payload = if fractional {
            payload == node_payload(node)
        } else {
            payload == *node
        };
        if parent.as_deref() != node["parent"].as_str()
            || !matches_order
            || text != node["text"].as_str().unwrap_or("")
            || !matches_payload
        {
            return msg(format!(
                "The document's indexed node {id} disagrees with the snapshot."
            ));
        }
    }
    let mut edges = connection.prepare("SELECT kind,id,from_id,to_id,edge_json FROM edges")?;
    let mut rows = edges.query([])?;
    while let Some(row) = rows.next()? {
        let (kind, id): (String, String) = (row.get(0)?, row.get(1)?);
        let Some((from, to, payload)) = doc.edges.get(&(kind.as_str(), id.as_str())) else {
            return msg("The document has an unexpected connection row.");
        };
        let expected = payload.cloned().unwrap_or_else(|| serde_json::json!({}));
        if row.get::<_, String>(2)? != *from
            || row.get::<_, String>(3)? != *to
            || serde_json::from_str::<Value>(&row.get::<_, String>(4)?)? != expected
        {
            return msg(format!(
                "The document's indexed connection {id} disagrees with the snapshot."
            ));
        }
    }
    let mut styles = connection.prepare("SELECT kind,owner_id,style_json FROM styles")?;
    let mut rows = styles.query([])?;
    while let Some(row) = rows.next()? {
        let (kind, owner): (String, String) = (row.get(0)?, row.get(1)?);
        let Some(style) = doc.styles.get(&(kind.as_str(), owner.as_str())) else {
            return msg("The document has an unexpected style row.");
        };
        if serde_json::from_str::<Value>(&row.get::<_, String>(2)?)? != **style {
            return msg("The document's indexed style disagrees with the snapshot.");
        }
    }
    let mut jobs = connection.prepare("SELECT id,job_json FROM ai_jobs")?;
    let mut rows = jobs.query([])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let Some(job) = doc.jobs.and_then(|jobs| jobs.get(&id)) else {
            return msg("The document has an unexpected AI job row.");
        };
        if serde_json::from_str::<Value>(&row.get::<_, String>(1)?)? != *job {
            return msg("The document's indexed AI job disagrees with the snapshot.");
        }
    }
    Ok(())
}
