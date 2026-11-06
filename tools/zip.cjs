// 最小 zip 读写器：支持 store(0) 与 deflate(8)
const fs=require('fs'), zlib=require('zlib'), path=require('path');

function readZip(file){
  const b=fs.readFileSync(file);
  let eocd=-1;
  for(let i=b.length-22;i>=0;i--){ if(b.readUInt32LE(i)===0x06054b50){ eocd=i; break; } }
  if(eocd<0) throw new Error('EOCD not found');
  const count=b.readUInt16LE(eocd+10);
  let off=b.readUInt32LE(eocd+16);
  const out=[];
  for(let n=0;n<count;n++){
    if(b.readUInt32LE(off)!==0x02014b50) throw new Error('bad CD sig at '+off);
    const method=b.readUInt16LE(off+10);
    const crc=b.readUInt32LE(off+16);
    const csize=b.readUInt32LE(off+20);
    const usize=b.readUInt32LE(off+24);
    const nameLen=b.readUInt16LE(off+28);
    const extraLen=b.readUInt16LE(off+30);
    const commentLen=b.readUInt16LE(off+32);
    const lho=b.readUInt32LE(off+42);
    const name=b.slice(off+46,off+46+nameLen).toString('utf8');
    // 本地头
    const lNameLen=b.readUInt16LE(lho+26);
    const lExtraLen=b.readUInt16LE(lho+28);
    const dataOff=lho+30+lNameLen+lExtraLen;
    const raw=b.slice(dataOff,dataOff+csize);
    const data= method===0? raw : zlib.inflateRawSync(raw);
    out.push({name,data});
    off+=46+nameLen+extraLen+commentLen;
  }
  return out;
}

function writeZip(file, entries, comment=''){
  const chunks=[]; const central=[]; let offset=0;
  const crcTable=(()=>{const t=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c;}return t;})();
  const crc32=buf=>{let c=-1;for(let i=0;i<buf.length;i++)c=crcTable[(c^buf[i])&0xFF]^(c>>>8);return (c^-1)>>>0;};
  for(const e of entries){
    const nameBuf=Buffer.from(e.name,'utf8');
    const data=Buffer.isBuffer(e.data)?e.data:Buffer.from(e.data,'utf8');
    const crc=crc32(data);
    const comp=zlib.deflateRawSync(data,{level:9});
    const useDeflate=comp.length<data.length;
    const payload=useDeflate?comp:data;
    const method=useDeflate?8:0;
    const lh=Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(20,4); lh.writeUInt16LE(0,6);
    lh.writeUInt16LE(method,8); lh.writeUInt16LE(0,10); lh.writeUInt16LE(0x21,12);
    lh.writeUInt32LE(crc,14); lh.writeUInt32LE(payload.length,18); lh.writeUInt32LE(data.length,22);
    lh.writeUInt16LE(nameBuf.length,26); lh.writeUInt16LE(0,28);
    chunks.push(lh,nameBuf,payload);
    const cd=Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50,0); cd.writeUInt16LE(20,4); cd.writeUInt16LE(20,6);
    cd.writeUInt16LE(0,8); cd.writeUInt16LE(method,10); cd.writeUInt16LE(0,12); cd.writeUInt16LE(0x21,14);
    cd.writeUInt32LE(crc,16); cd.writeUInt32LE(payload.length,20); cd.writeUInt32LE(data.length,24);
    cd.writeUInt16LE(nameBuf.length,28); cd.writeUInt16LE(0,30); cd.writeUInt16LE(0,32);
    cd.writeUInt16LE(0,34); cd.writeUInt16LE(0,36); cd.writeUInt32LE(0,38);
    cd.writeUInt32LE(offset,42);
    central.push(cd,nameBuf);
    offset+=30+nameBuf.length+payload.length;
  }
  const cdBuf=Buffer.concat(central);
  const commentBuf=Buffer.from(comment,'utf8');
  const eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(0,4); eocd.writeUInt16LE(0,6);
  eocd.writeUInt16LE(entries.length,8); eocd.writeUInt16LE(entries.length,10);
  eocd.writeUInt32LE(cdBuf.length,12); eocd.writeUInt32LE(offset,16);
  eocd.writeUInt16LE(commentBuf.length,20);
  fs.writeFileSync(file, Buffer.concat([...chunks,cdBuf,eocd,commentBuf]));
}

module.exports={readZip,writeZip};
