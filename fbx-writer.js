// Minimal binary FBX 7.4 writer for static triangle meshes (no skinning or
// animation). Blender cannot import ASCII FBX, so the binary layout is required.

const FBX_VERSION = 7400;
const HEADER_MAGIC = "Kaydara FBX Binary  \0";
const NULL_RECORD_SIZE = 13;
const NAME_SEPARATOR = "\0\x01";

// Fixed trailer bytes every FBX file ends with (values taken from the format
// as written by other exporters; importers do not validate them).
const FOOTER_ID = [0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e];
const FOOTER_MAGIC = [0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b];
const FILE_ID = [0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1];

const encoder = new TextEncoder();

class ByteWriter {
  constructor() {
    this.bytes = new Uint8Array(1 << 20);
    this.view = new DataView(this.bytes.buffer);
    this.pos = 0;
  }

  reserve(extra) {
    const needed = this.pos + extra;
    if (needed <= this.bytes.length) return;

    let size = this.bytes.length;
    while (size < needed) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.bytes);
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }

  u8(value) {
    this.reserve(1);
    this.view.setUint8(this.pos++, value);
  }

  i16(value) {
    this.reserve(2);
    this.view.setInt16(this.pos, value, true);
    this.pos += 2;
  }

  u32(value) {
    this.reserve(4);
    this.view.setUint32(this.pos, value, true);
    this.pos += 4;
  }

  i32(value) {
    this.reserve(4);
    this.view.setInt32(this.pos, value, true);
    this.pos += 4;
  }

  i64(value) {
    this.reserve(8);
    this.view.setBigInt64(this.pos, BigInt(value), true);
    this.pos += 8;
  }

  f64(value) {
    this.reserve(8);
    this.view.setFloat64(this.pos, value, true);
    this.pos += 8;
  }

  raw(bytes) {
    this.reserve(bytes.length);
    this.bytes.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  zeros(count) {
    this.reserve(count);
    this.pos += count;
  }

  patchU32(offset, value) {
    this.view.setUint32(offset, value, true);
  }

  result() {
    return this.bytes.slice(0, this.pos);
  }
}

// Property constructors: each returns { type, value } for writeProperty.
const int16 = (value) => ({ type: "Y", value });
const int32 = (value) => ({ type: "I", value });
const int64 = (value) => ({ type: "L", value });
const double = (value) => ({ type: "D", value });
const bool = (value) => ({ type: "C", value: value ? 1 : 0 });
const string = (value) => ({ type: "S", value });
const doubles = (value) => ({ type: "d", value: Float64Array.from(value) });
const ints = (value) => ({ type: "i", value: Int32Array.from(value) });

const node = (name, properties = [], children = []) => ({ name, properties, children });

// FBX object names are stored as "Name\0\x01Class".
const objectName = (name, kind) => string(`${name}${NAME_SEPARATOR}${kind}`);

function writeArrayProperty(writer, type, array) {
  writer.u8(type.charCodeAt(0));
  writer.u32(array.length);
  writer.u32(0); // encoding: uncompressed
  writer.u32(array.byteLength);
  // Typed arrays are little-endian on every platform Chrome runs on.
  writer.raw(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
}

function writeProperty(writer, { type, value }) {
  if (type === "d" || type === "i") return writeArrayProperty(writer, type, value);

  writer.u8(type.charCodeAt(0));
  if (type === "Y") writer.i16(value);
  else if (type === "I") writer.i32(value);
  else if (type === "L") writer.i64(value);
  else if (type === "D") writer.f64(value);
  else if (type === "C") writer.u8(value);
  else {
    const bytes = encoder.encode(value);
    writer.u32(bytes.length);
    writer.raw(bytes);
  }
}

// Record layout (7.4): endOffset, numProperties, propertyListLen (uint32 each),
// nameLen (uint8), name, properties, nested records, 13-byte null record.
function writeNode(writer, { name, properties, children }) {
  const start = writer.pos;
  writer.u32(0); // endOffset, patched below
  writer.u32(properties.length);
  writer.u32(0); // propertyListLen, patched below
  const nameBytes = encoder.encode(name);
  writer.u8(nameBytes.length);
  writer.raw(nameBytes);

  const propertiesStart = writer.pos;
  properties.forEach((property) => writeProperty(writer, property));
  writer.patchU32(start + 8, writer.pos - propertiesStart);

  if (children.length > 0) {
    children.forEach((child) => writeNode(writer, child));
    writer.zeros(NULL_RECORD_SIZE);
  }
  writer.patchU32(start, writer.pos);
}

function writeFooter(writer) {
  writer.zeros(NULL_RECORD_SIZE);
  writer.raw(FOOTER_ID);
  writer.zeros(4);
  // Pad to 16 bytes (a full block when already aligned), then version and magic.
  const padding = (16 - (writer.pos % 16)) % 16 || 16;
  writer.zeros(padding);
  writer.u32(FBX_VERSION);
  writer.zeros(120);
  writer.raw(FOOTER_MAGIC);
}

// Properties70 entry: name, type, label, flags, then the value(s).
const prop = (name, type, label, ...values) =>
  node("P", [string(name), string(type), string(label), string(""), ...values]);

function headerNodes() {
  return [
    node("FBXHeaderExtension", [], [
      node("FBXHeaderVersion", [int32(1003)]),
      node("FBXVersion", [int32(FBX_VERSION)]),
      node("Creator", [string("Meshy Asset Counter")]),
    ]),
    node("FileId", [{ type: "R", value: Uint8Array.from(FILE_ID) }]),
    node("CreationTime", [string("1970-01-01 10:00:00:000")]),
    node("Creator", [string("Meshy Asset Counter")]),
  ];
}

function globalSettingsNode() {
  return node("GlobalSettings", [], [
    node("Version", [int32(1000)]),
    node("Properties70", [], [
      prop("UpAxis", "int", "Integer", int32(1)),
      prop("UpAxisSign", "int", "Integer", int32(1)),
      prop("FrontAxis", "int", "Integer", int32(2)),
      prop("FrontAxisSign", "int", "Integer", int32(1)),
      prop("CoordAxis", "int", "Integer", int32(0)),
      prop("CoordAxisSign", "int", "Integer", int32(1)),
      // Coordinates are meters; the scale factor is centimeters per unit.
      prop("UnitScaleFactor", "double", "Number", double(100)),
      prop("OriginalUnitScaleFactor", "double", "Number", double(100)),
    ]),
  ]);
}

function documentsNode() {
  return node("Documents", [], [
    node("Count", [int32(1)]),
    node("Document", [int64(1), string(""), string("Scene")], [
      node("Properties70", [], [prop("SourceObject", "object", "", string("")), prop("ActiveAnimStackName", "KString", "", string(""))]),
      node("RootNode", [int64(0)]),
    ]),
  ]);
}

function definitionsNode(count) {
  const type = (name, total) => node("ObjectType", [string(name)], [node("Count", [int32(total)])]);
  return node("Definitions", [], [
    node("Version", [int32(100)]),
    node("Count", [int32(1 + count * 3)]),
    type("GlobalSettings", 1),
    type("Model", count),
    type("Geometry", count),
    type("Material", count),
  ]);
}

// Triangle corners; the last index of every polygon is stored as ~index.
function polygonVertexIndex(indices) {
  const result = new Int32Array(indices.length);
  for (let i = 0; i < indices.length; i += 3) {
    result[i] = indices[i];
    result[i + 1] = indices[i + 1];
    result[i + 2] = -indices[i + 2] - 1;
  }
  return result;
}

// One normal per polygon corner (ByPolygonVertex / Direct).
function cornerNormals(normals, indices) {
  const result = new Float64Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) {
    result[i * 3] = normals[indices[i] * 3];
    result[i * 3 + 1] = normals[indices[i] * 3 + 1];
    result[i * 3 + 2] = normals[indices[i] * 3 + 2];
  }
  return result;
}

function layerElement(type, name, mapping, reference, children) {
  return node(type, [int32(0)], [
    node("Version", [int32(101)]),
    node("Name", [string(name)]),
    node("MappingInformationType", [string(mapping)]),
    node("ReferenceInformationType", [string(reference)]),
    ...children,
  ]);
}

function geometryNode(id, mesh) {
  const { positions, normals, uvs, indices } = mesh;
  const elements = [
    layerElement("LayerElementNormal", "", "ByPolygonVertex", "Direct", [
      node("Normals", [doubles(cornerNormals(normals, indices))]),
    ]),
  ];
  if (uvs) {
    elements.push(
      layerElement("LayerElementUV", "UVMap", "ByPolygonVertex", "IndexToDirect", [
        node("UV", [doubles(uvs)]),
        node("UVIndex", [ints(indices)]),
      ]),
    );
  }
  elements.push(
    layerElement("LayerElementMaterial", "", "AllSame", "IndexToDirect", [node("Materials", [ints([0])])]),
  );

  const layerTypes = elements.map((element) =>
    node("LayerElement", [], [node("Type", [string(element.name)]), node("TypedIndex", [int32(0)])]),
  );

  return node("Geometry", [int64(id), objectName(mesh.name, "Geometry"), string("Mesh")], [
    node("Vertices", [doubles(positions)]),
    node("PolygonVertexIndex", [ints(polygonVertexIndex(indices))]),
    node("GeometryVersion", [int32(124)]),
    ...elements,
    node("Layer", [int32(0)], [node("Version", [int32(100)]), ...layerTypes]),
  ]);
}

function modelNode(id, name) {
  return node("Model", [int64(id), objectName(name, "Model"), string("Mesh")], [
    node("Version", [int32(232)]),
    node("Properties70", [], [prop("InheritType", "enum", "", int32(1))]),
    node("Shading", [bool(true)]),
    node("Culling", [string("CullingOff")]),
  ]);
}

function materialNode(id, name) {
  return node("Material", [int64(id), objectName(name, "Material"), string("")], [
    node("Version", [int32(102)]),
    node("ShadingModel", [string("phong")]),
    node("MultiLayer", [int32(0)]),
    node("Properties70", [], [prop("DiffuseColor", "Color", "", double(0.8), double(0.8), double(0.8))]),
  ]);
}

const connection = (child, parent) => node("C", [string("OO"), int64(child), int64(parent)]);

function objectNodes(meshes) {
  const objects = [];
  const connections = [];
  let nextId = 100000;

  for (const mesh of meshes) {
    const modelId = nextId++;
    const geometryId = nextId++;
    const materialId = nextId++;

    objects.push(geometryNode(geometryId, mesh), modelNode(modelId, mesh.name), materialNode(materialId, mesh.name));
    connections.push(connection(modelId, 0), connection(geometryId, modelId), connection(materialId, modelId));
  }

  return {
    objects: node("Objects", [], objects),
    connections: node("Connections", [], connections),
  };
}

// meshes: [{ name, positions, normals, uvs | null, indices }] in world space.
export function writeFbx(meshes) {
  const writer = new ByteWriter();
  writer.raw(encoder.encode(HEADER_MAGIC));
  writer.raw([0x1a, 0x00]);
  writer.u32(FBX_VERSION);

  const { objects, connections } = objectNodes(meshes);
  const topLevel = [
    ...headerNodes(),
    globalSettingsNode(),
    documentsNode(),
    node("References"),
    definitionsNode(meshes.length),
    objects,
    connections,
  ];
  topLevel.forEach((record) => writeNode(writer, record));
  writeFooter(writer);

  return writer.result();
}
