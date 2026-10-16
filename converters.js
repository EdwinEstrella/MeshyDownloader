import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  GLTFLoader,
  Matrix3,
  Mesh,
  MeshStandardMaterial,
  OBJExporter,
  STLExporter,
  Uint32BufferAttribute,
  Vector3,
  strToU8,
  zipSync,
} from "./vendor/three-bundle.js";
import { writeFbx } from "./fbx-writer.js";

const BLOB_TYPE = "application/octet-stream";

function skipMaterials() {
  return { name: "skip_materials", loadMaterial: () => Promise.resolve(new MeshStandardMaterial()) };
}

function parseGlb(arrayBuffer) {
  const loader = new GLTFLoader();
  loader.register(skipMaterials);
  return new Promise((resolve, reject) => {
    loader.parse(arrayBuffer, "", (gltf) => resolve(gltf.scene), reject);
  });
}

function bakeMesh(mesh, index) {
  const geometry = mesh.geometry;
  const source = geometry.attributes.position;
  const count = source.count;
  const positions = new Float32Array(count * 3);
  const vertex = new Vector3();

  for (let i = 0; i < count; i++) {
    if (mesh.isSkinnedMesh) mesh.getVertexPosition(i, vertex);
    else vertex.fromBufferAttribute(source, i);
    vertex.applyMatrix4(mesh.matrixWorld).toArray(positions, i * 3);
  }

  const indices = geometry.index
    ? Uint32Array.from(geometry.index.array)
    : Uint32Array.from({ length: count }, (_, i) => i);

  if (mesh.matrixWorld.determinant() < 0) flipWinding(indices);

  return {
    name: mesh.name || `Mesh_${index}`,
    positions,
    normals: bakeNormals(mesh, positions, indices),
    uvs: bakeUvs(geometry),
    indices,
  };
}

function flipWinding(indices) {
  for (let i = 0; i < indices.length; i += 3) {
    [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  }
}

function bakeNormals(mesh, positions, indices) {
  const source = mesh.geometry.attributes.normal;

  if (!source || mesh.isSkinnedMesh) {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setIndex(new Uint32BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    return geometry.attributes.normal.array;
  }

  const normalMatrix = new Matrix3().getNormalMatrix(mesh.matrixWorld);
  const normals = new Float32Array(source.count * 3);
  const normal = new Vector3();
  for (let i = 0; i < source.count; i++) {
    normal.fromBufferAttribute(source, i).applyMatrix3(normalMatrix).normalize().toArray(normals, i * 3);
  }
  return normals;
}

function bakeUvs(geometry) {
  const source = geometry.attributes.uv;
  if (!source) return null;

  const uvs = new Float32Array(source.count * 2);
  for (let i = 0; i < source.count; i++) {
    uvs[i * 2] = source.getX(i);
    uvs[i * 2 + 1] = 1 - source.getY(i);
  }
  return uvs;
}

function bakeScene(scene) {
  scene.updateMatrixWorld(true);
  const meshes = [];
  scene.traverse((object) => {
    if (object.isMesh && object.geometry.attributes.position) meshes.push(object);
  });
  if (meshes.length === 0) throw new Error("The GLB contains no meshes");
  return meshes.map(bakeMesh);
}

function toExportScene(baked) {
  const group = new Group();
  for (const data of baked) {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(data.positions, 3));
    geometry.setAttribute("normal", new Float32BufferAttribute(data.normals, 3));
    if (data.uvs) geometry.setAttribute("uv", new Float32BufferAttribute(data.uvs, 2));
    geometry.setIndex(new Uint32BufferAttribute(data.indices, 1));

    const mesh = new Mesh(geometry, new MeshStandardMaterial());
    mesh.name = data.name;
    group.add(mesh);
  }
  group.updateMatrixWorld(true);
  return group;
}

function toObj(baked) {
  return new OBJExporter().parse(toExportScene(baked));
}

function toStl(baked) {
  return new STLExporter().parse(toExportScene(baked), { binary: true });
}

const precise = (value) => Number(value.toPrecision(8));

function buildModelXml(baked) {
  const vertices = [];
  const triangles = [];
  let offset = 0;

  for (const { positions, indices } of baked) {
    for (let i = 0; i < positions.length; i += 3) {
      vertices.push(
        `<vertex x="${precise(positions[i])}" y="${precise(-positions[i + 2])}" z="${precise(positions[i + 1])}"/>`,
      );
    }
    for (let i = 0; i < indices.length; i += 3) {
      triangles.push(
        `<triangle v1="${indices[i] + offset}" v2="${indices[i + 1] + offset}" v3="${indices[i + 2] + offset}"/>`,
      );
    }
    offset += positions.length / 3;
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="meter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    '<resources><object id="1" type="model"><mesh>',
    `<vertices>${vertices.join("")}</vertices>`,
    `<triangles>${triangles.join("")}</triangles>`,
    "</mesh></object></resources>",
    '<build><item objectid="1"/></build>',
    "</model>",
  ].join("");
}

function to3mf(baked) {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    "</Types>";
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
    "</Relationships>";

  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rels),
    "3D/3dmodel.model": strToU8(buildModelXml(baked)),
  });
}

// ---------------------------------------------------------
// Texture and Image Extraction Helpers
// ---------------------------------------------------------
export function extractImagesFromGlb(arrayBuffer) {
  try {
    const dataView = new DataView(arrayBuffer);
    const magic = dataView.getUint32(0, true);
    if (magic !== 0x46546C67) return [];

    const jsonChunkLen = dataView.getUint32(12, true);
    const jsonBytes = new Uint8Array(arrayBuffer, 20, jsonChunkLen);
    const jsonText = new TextDecoder().decode(jsonBytes);
    const gltf = JSON.parse(jsonText);

    const binChunkOffset = 20 + jsonChunkLen;
    if (binChunkOffset >= arrayBuffer.byteLength) return [];
    const binDataOffset = binChunkOffset + 8;

    const images = [];
    if (Array.isArray(gltf.images)) {
      gltf.images.forEach((img, idx) => {
        if (img.bufferView !== undefined && gltf.bufferViews?.[img.bufferView]) {
          const bv = gltf.bufferViews[img.bufferView];
          const offset = binDataOffset + (bv.byteOffset || 0);
          const length = bv.byteLength;
          const bytes = new Uint8Array(arrayBuffer, offset, length);
          const ext = img.mimeType === "image/jpeg" ? "jpg" : "png";
          images.push({
            name: img.name || `texture_${idx}`,
            ext,
            bytes: bytes.slice()
          });
        }
      });
    }
    return images;
  } catch (err) {
    console.warn("Error extracting images from GLB:", err);
    return [];
  }
}

async function collectTextureFiles(arrayBuffer, textureUrls) {
  const files = {};
  let map = null;
  if (Array.isArray(textureUrls) && textureUrls.length > 0) map = textureUrls[0];
  else if (textureUrls && typeof textureUrls === "object") map = textureUrls;

  const keys = [
    { key: "colorMapUrl", filename: "textures/diffuse.png" },
    { key: "normalMapUrl", filename: "textures/normal.png" },
    { key: "roughnessMapUrl", filename: "textures/roughness.png" },
    { key: "metallicMapUrl", filename: "textures/metallic.png" }
  ];

  let fetchedAny = false;
  if (map) {
    await Promise.all(
      keys.map(async ({ key, filename }) => {
        const url = map[key];
        if (url && typeof url === "string" && url.startsWith("http")) {
          try {
            const res = await fetch(url);
            if (res.ok) {
              const buf = await res.arrayBuffer();
              files[filename] = new Uint8Array(buf);
              fetchedAny = true;
            }
          } catch (e) {}
        }
      })
    );
  }

  if (!fetchedAny && arrayBuffer) {
    const embedded = extractImagesFromGlb(arrayBuffer);
    embedded.forEach((img, idx) => {
      const filename = idx === 0 ? "textures/diffuse.png" :
                       idx === 1 ? "textures/normal.png" :
                       idx === 2 ? "textures/roughness.png" :
                       idx === 3 ? "textures/metallic.png" :
                       `textures/${img.name}.${img.ext}`;
      files[filename] = img.bytes;
    });
  }

  return files;
}

// ---------------------------------------------------------
// ZIP Packaging Workflows
// ---------------------------------------------------------
export async function packageObjZip(arrayBuffer, modelName = "model", textureUrls = null) {
  const baked = bakeScene(await parseGlb(arrayBuffer));
  const rawObj = toObj(baked);
  const mtlFilename = `${modelName}.mtl`;
  const objContent = `mtllib ${mtlFilename}\nusemtl Material_0\n` + rawObj;

  const mtlContent = [
    `# Material definition for ${modelName}`,
    `newmtl Material_0`,
    `Ka 1.0 1.0 1.0`,
    `Kd 1.0 1.0 1.0`,
    `Ks 0.0 0.0 0.0`,
    `d 1.0`,
    `illum 2`,
    `map_Kd textures/diffuse.png`,
    `map_Bump textures/normal.png`,
    `map_Ns textures/roughness.png`,
    `map_Pm textures/metallic.png`
  ].join("\n");

  const textureFiles = await collectTextureFiles(arrayBuffer, textureUrls);

  const zipFiles = {
    [`${modelName}.obj`]: strToU8(objContent),
    [mtlFilename]: strToU8(mtlContent),
    ...textureFiles
  };

  const zipBuffer = zipSync(zipFiles);
  return new Blob([zipBuffer], { type: "application/zip" });
}

export async function packageFbxZip(arrayBuffer, modelName = "model", textureUrls = null) {
  const baked = bakeScene(await parseGlb(arrayBuffer));
  const fbxContent = writeFbx(baked);
  const textureFiles = await collectTextureFiles(arrayBuffer, textureUrls);

  const zipFiles = {
    [`${modelName}.fbx`]: strToU8(fbxContent),
    ...textureFiles
  };

  const zipBuffer = zipSync(zipFiles);
  return new Blob([zipBuffer], { type: "application/zip" });
}

export async function packageTexturesZip(arrayBuffer, modelName = "model", textureUrls = null) {
  const textureFiles = await collectTextureFiles(arrayBuffer, textureUrls);
  if (Object.keys(textureFiles).length === 0) {
    throw new Error("No texture maps found for this model.");
  }

  const flatFiles = {};
  for (const [k, v] of Object.entries(textureFiles)) {
    const flatName = k.replace(/^textures\//, "");
    flatFiles[`${modelName}_${flatName}`] = v;
  }

  const zipBuffer = zipSync(flatFiles);
  return new Blob([zipBuffer], { type: "application/zip" });
}

export async function packageFullBundleZip(arrayBuffer, modelName = "model", textureUrls = null) {
  const baked = bakeScene(await parseGlb(arrayBuffer));
  const rawObj = toObj(baked);
  const fbxContent = writeFbx(baked);
  const stlData = toStl(baked);
  const mfContent = to3mf(baked);

  const mtlFilename = `${modelName}.mtl`;
  const objContent = `mtllib ${mtlFilename}\nusemtl Material_0\n` + rawObj;
  const mtlContent = [
    `# Material definition for ${modelName}`,
    `newmtl Material_0`,
    `Ka 1.0 1.0 1.0`,
    `Kd 1.0 1.0 1.0`,
    `Ks 0.0 0.0 0.0`,
    `d 1.0`,
    `illum 2`,
    `map_Kd textures/diffuse.png`,
    `map_Bump textures/normal.png`,
    `map_Ns textures/roughness.png`,
    `map_Pm textures/metallic.png`
  ].join("\n");

  const textureFiles = await collectTextureFiles(arrayBuffer, textureUrls);

  const zipFiles = {
    [`${modelName}.glb`]: new Uint8Array(arrayBuffer),
    [`${modelName}.obj`]: strToU8(objContent),
    [mtlFilename]: strToU8(mtlContent),
    [`${modelName}.fbx`]: strToU8(fbxContent),
    [`${modelName}.stl`]: new Uint8Array(stlData.buffer, stlData.byteOffset, stlData.byteLength),
    [`${modelName}.3mf`]: mfContent,
    ...textureFiles
  };

  const zipBuffer = zipSync(zipFiles);
  return new Blob([zipBuffer], { type: "application/zip" });
}

export async function convertGlb(arrayBuffer, format) {
  const baked = bakeScene(await parseGlb(arrayBuffer));
  if (format === "STL") {
    const stl = toStl(baked);
    return new Blob([stl], { type: BLOB_TYPE });
  }
  if (format === "3MF") {
    const mf = to3mf(baked);
    return new Blob([mf], { type: "application/vnd.ms-package.3dmanufacturing-3dmodel+xml" });
  }
  if (format === "FBX") {
    return new Blob([writeFbx(baked)], { type: BLOB_TYPE });
  }
  if (format === "OBJ") {
    return new Blob([toObj(baked)], { type: BLOB_TYPE });
  }
  throw new Error(`Unsupported direct format: ${format}`);
}
