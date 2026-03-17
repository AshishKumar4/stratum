/**
 * AHCI Virtual Disk Management
 * 
 * This module provides virtual disk management for AHCI, including integration
 * with Durable Objects for persistent storage in a Cloudflare Workers environment.
 */

import { LOG_DISK } from "./const.js";
import { h } from "./lib.js";
import { dbg_assert, dbg_log } from "./log.js";

// Virtual disk types
export const DISK_TYPE_RAM = "ram";           // In-memory disk (non-persistent)
export const DISK_TYPE_DURABLE = "durable";   // Durable Object storage  
export const DISK_TYPE_FILE = "file";         // File-based (for Node.js)
export const DISK_TYPE_BUFFER = "buffer";     // Provided buffer

// Disk geometry constants
export const SECTOR_SIZE = 512;
export const SECTORS_PER_TRACK = 63;
export const HEADS_PER_CYLINDER = 16;
export const DEFAULT_DISK_SIZE = 1024 * 1024 * 1024; // 1GB

/**
 * Virtual Disk Interface
 * 
 * Abstract base class for all virtual disk types
 */
export class VirtualDisk {
    constructor(size = DEFAULT_DISK_SIZE, sector_size = SECTOR_SIZE) {
        this.size = size;
        this.sector_size = sector_size;
        this.sectors = Math.floor(size / sector_size);
        this.read_only = false;
        this.disk_type = "unknown";
        this.last_access_time = Date.now();
        
        // Calculate CHS geometry
        this.calculate_geometry();
        
        dbg_log("Virtual Disk created: size=" + size + " sectors=" + this.sectors, LOG_DISK);
    }
    
    /**
     * Calculate CHS (Cylinder/Head/Sector) geometry
     */
    calculate_geometry() {
        const total_sectors = this.sectors;
        
        // Use standard disk geometry calculations
        this.heads = HEADS_PER_CYLINDER;
        this.sectors_per_track = SECTORS_PER_TRACK;
        this.cylinders = Math.floor(total_sectors / (this.heads * this.sectors_per_track));
        
        // Ensure we don't exceed common limits
        if (this.cylinders > 65535) {
            this.cylinders = 65535;
        }
        
        dbg_log("Virtual Disk geometry: C=" + this.cylinders + " H=" + this.heads + 
               " S=" + this.sectors_per_track, LOG_DISK);
    }
    
    /**
     * Read sectors from disk
     * @param {number} lba - Logical Block Address
     * @param {number} count - Number of sectors to read
     * @returns {Promise<Uint8Array>} Read data
     */
    async read_sectors(lba, count) {
        throw new Error("read_sectors must be implemented by subclass");
    }
    
    /**
     * Write sectors to disk
     * @param {number} lba - Logical Block Address
     * @param {Uint8Array} data - Data to write
     * @returns {Promise<number>} Number of sectors written
     */
    async write_sectors(lba, data) {
        throw new Error("write_sectors must be implemented by subclass");
    }
    
    /**
     * Flush any cached data to persistent storage
     * @returns {Promise<void>}
     */
    async flush() {
        // Default implementation - no-op
    }
    
    /**
     * Get disk information
     */
    get_info() {
        return {
            size: this.size,
            sectors: this.sectors,
            sector_size: this.sector_size,
            cylinders: this.cylinders,
            heads: this.heads,
            sectors_per_track: this.sectors_per_track,
            read_only: this.read_only,
            disk_type: this.disk_type,
            last_access: this.last_access_time,
        };
    }
    
    /**
     * Validate LBA range
     * @param {number} lba - Starting LBA
     * @param {number} count - Number of sectors
     * @returns {boolean} True if valid
     */
    validate_range(lba, count) {
        if (lba < 0 || count <= 0) {
            return false;
        }
        if (lba + count > this.sectors) {
            return false;
        }
        return true;
    }
    
    /**
     * Update last access time
     */
    update_access_time() {
        this.last_access_time = Date.now();
    }
}

/**
 * Format a buffer with a minimal valid Aqeous-compatible EXT2 filesystem.
 *
 * The layout matches what Aqeous's ext2_set_block_group() / ext2_burn() would
 * produce so that ext2_initialize() → ext2_read_meta_data() succeeds and
 * ext2_inode_from_offset(1) returns a valid root directory with "." and ".."
 * entries.
 *
 * Block size = 1024, sector size = 512.  Addresses stored in on-disk structs
 * are SECTOR numbers (LBA), matching how Aqeous's disk_read(port, start_sector,
 * byte_count, buf) works.
 *
 * @param {Uint8Array} buf  – The raw disk buffer (must be zeroed)
 * @param {number}     size – Disk size in bytes (must be a multiple of 1024)
 */
function format_ext2(buf, size) {
    const BLOCK_SZ   = 1024;
    const SECT_SZ    = 512;
    const EXT2_MAGIC = 0xEF53;

    // --- Geometry -------------------------------------------------------
    const total_blocks    = (size / BLOCK_SZ) >>> 0;       // e.g. 32768 for 32 MB
    const blocks_per_group = total_blocks;                  // single block group
    const nblock_groups   = 1;
    const inodes_per_group = 214;                           // EXT2_I_PER_GRP
    const INODE_STRUCT_SZ = 140;                            // sizeof(ext2_inode_t) on i686
    const inode_table_size_blocks = ((inodes_per_group * INODE_STRUCT_SZ) / BLOCK_SZ) >>> 0; // 29

    // --- Sector locations (same formulas as ext2_set_block_group) --------
    //   SB at sector 2, GDT at sector 4
    const sblock_sector = (1024 / SECT_SZ) >>> 0;                                              // 2
    const gdesc_sector  = ((1024 + BLOCK_SZ) / SECT_SZ) >>> 0;                                 // 4
    const bb_sector     = ((1024 + BLOCK_SZ + BLOCK_SZ * nblock_groups) / SECT_SZ) >>> 0;      // 6
    const ib_sector     = ((1024 + 2 * BLOCK_SZ + BLOCK_SZ * nblock_groups) / SECT_SZ) >>> 0;  // 8
    const it_sector     = ((1024 + 3 * BLOCK_SZ + BLOCK_SZ * nblock_groups) / SECT_SZ) >>> 0;  // 10

    // Byte offsets for convenience
    const sblock_off = sblock_sector * SECT_SZ;   // 1024
    const gdesc_off  = gdesc_sector  * SECT_SZ;   // 2048
    const bb_off     = bb_sector     * SECT_SZ;    // 3072
    const ib_off     = ib_sector     * SECT_SZ;    // 4096
    const it_off     = it_sector     * SECT_SZ;    // 5120

    // The first data block comes right after the inode table
    //   begining_offset = it_sector + BLOCKS_TO_SECTORS(inode_table_size_blocks)
    const data_start_sector = it_sector + inode_table_size_blocks * 2;  // 10 + 58 = 68
    const root_dir_sector   = data_start_sector;  // first allocated block → sector 68
    const root_dir_off      = root_dir_sector * SECT_SZ;               // 34816

    // --- Helpers ---------------------------------------------------------
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    function w8(off, v)  { buf[off] = v & 0xFF; }
    function w16(off, v) { dv.setUint16(off, v, true); }
    function w32(off, v) { dv.setUint32(off, v, true); }

    function wstr(off, s) {
        for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
    }

    // === 1. Superblock (at byte 1024) ====================================
    const S = sblock_off;
    w32(S +  0, inodes_per_group * nblock_groups);    // total_inodes
    w32(S +  4, total_blocks);                         // total_blocks
    w32(S +  8, 0);                                    // reserved_blocks
    w32(S + 12, total_blocks - 40);                    // free_blocks (approx)
    w32(S + 16, inodes_per_group - 2);                 // free_inodes (mother root + root taken)
    w32(S + 20, sblock_sector);                        // first_data_block (sector of SB)
    w32(S + 24, BLOCK_SZ);                             // block_size
    w32(S + 28, 0);                                    // fragment_size
    w32(S + 32, blocks_per_group);                     // blocks_per_group
    w32(S + 36, 0);                                    // fragments_per_group
    w32(S + 40, inodes_per_group);                     // inodes_per_group
    w32(S + 44, 0);                                    // mtime
    w32(S + 48, 0);                                    // wtime
    w16(S + 52, 0);                                    // mnt_count
    w16(S + 54, 20);                                   // max_mnt_count (EXT2_MAX_MNT_COUNT)
    w16(S + 56, EXT2_MAGIC);                           // magic  ← critical check
    w16(S + 58, 0);                                    // fs_state (EXT2_VALID_FS = 0)
    w16(S + 60, 1);                                    // error_handling (EXT2_ERRORS_CONTINUE)
    w16(S + 62, 0);                                    // minor_revision_level
    w32(S + 64, 0);                                    // lastcheck
    w32(S + 68, 3600);                                 // checkinterval
    w32(S + 72, 5);                                    // creator_os (EXT2_OS_JSOS)
    w32(S + 76, 0);                                    // revision_level (EXT2_GOOD_OLD_REV)
    w16(S + 80, 0);                                    // uid_reserved
    w16(S + 82, 0);                                    // gid_reserved
    w32(S + 84, 0);                                    // first_inode (mother root = 0)
    w16(S + 88, INODE_STRUCT_SZ);                      // inode_struct_max = sizeof(ext2_inode_t)
    w16(S + 90, 0);                                    // block_group_number
    w32(S + 92, 0);                                    // feature_compatibility
    w32(S + 96, 0);                                    // feature_incompat
    w32(S + 100, 0);                                   // feature_ro_compat
    // unique_id[8] at +104..+119 — leave zeroed
    wstr(S + 120, "Primary");                          // volume_name[16]
    // last_mounted_on[64] at +136..+199 — leave zeroed
    w32(S + 200, 0);                                   // compression_info (EXT2_NO_ALG)

    // === 2. Group Descriptor (at byte 2048) ==============================
    const free_blocks = blocks_per_group - (3 + inode_table_size_blocks + nblock_groups);
    const G = gdesc_off;
    w32(G +  0, bb_sector);                            // block_bitmap (sector)
    w32(G +  4, ib_sector);                            // inode_bitmap (sector)
    w32(G +  8, it_sector);                            // inode_table_id (sector)
    w16(G + 12, free_blocks & 0xFFFF);                 // free_blocks
    w16(G + 14, inodes_per_group - 2);                 // free_inodes (after mother root + root)
    w16(G + 16, 1);                                    // used_dirs (root)
    w16(G + 18, 0);                                    // pad
    w32(G + 20, inode_table_size_blocks);              // inode_table_size
    w32(G + 24, gdesc_sector);                         // gdesc_location (sector)
    w32(G + 28, 0);                                    // reserved

    // === 3. Block bitmap (at bb_off) =====================================
    // Bit 7 of byte 0 = block 0 (first data block) → mark allocated
    buf[bb_off] = 0x80;

    // === 4. Inode bitmap (at ib_off) =====================================
    // Inode 1 → bit 7 of byte 0.  Inode 0 (mother root) is implicit/untracked.
    buf[ib_off] = 0x80;

    // === 5. Inode table (at it_off) ======================================
    //
    // ext2_inode_t layout (140 bytes, natural i686 alignment):
    //   +0    uint8_t  magic          (1 byte + 3 pad)
    //   +4    uint32_t inode
    //   +8    uint16_t mode           (2 bytes + 2 pad)
    //   +12   uint32_t type
    //   +16   uint16_t uid            (2 bytes + 2 pad)
    //   +20   uint32_t size
    //   +24   uint32_t atime
    //   +28   uint32_t ctime
    //   +32   uint32_t mtime
    //   +36   uint32_t dtime
    //   +40   uint16_t gid
    //   +42   uint16_t nlinks
    //   +44   uint16_t nblocks        (sectors, i.e. blocks*2)
    //   +46   uint16_t flags
    //   +48   uint16_t osd1           (2 bytes + 2 pad)
    //   +52   uint32_t blocks[15]     (60 bytes, +52..+111)
    //   +112  uint16_t version
    //   +114  uint16_t fire_acl
    //   +116  uint16_t dir_acl
    //   +118  uint16_t fragment_addr
    //   +120  uint16_t osd2[3]        (6 bytes)
    //   +126  uint8_t  reserved[13]
    //   +139  1 byte pad → 140 total

    const EXT2_DIR = 2;       // enum EXT2_DIRENT { ..., EXT2_DIR = 2 }
    const M_EXT2   = 0xEF53 & 0xFF;  // M_EXT2 stored as uint8_t → 0x53
    const EXT2_OS_JSOS = 5;
    // mode flags: RUSR|WUSR|XUSR|RGRP|XGRP|ROTH|XOTH = 0x01ED
    const ROOT_MODE = 0x0100 | 0x0080 | 0x0040 | 0x0020 | 0x0008 | 0x0004 | 0x0001;

    // Inode 0: "mother root" – empty directory (size=0, no blocks)
    const I0 = it_off + 0 * INODE_STRUCT_SZ;
    w8 (I0 +  0, M_EXT2);              // magic (uint8_t)
    w32(I0 +  4, 0);                    // inode = 0
    w16(I0 +  8, ROOT_MODE);           // mode
    w32(I0 + 12, EXT2_DIR);            // type
    w32(I0 + 20, 0);                    // size = 0
    w16(I0 + 42, 2);                    // nlinks = 2
    w16(I0 + 44, 0);                    // nblocks = 0
    w16(I0 + 48, EXT2_OS_JSOS);        // osd1

    // Inode 1: root "/" – has 1 block with "." and ".." entries
    const I1 = it_off + 1 * INODE_STRUCT_SZ;
    w8 (I1 +  0, M_EXT2);              // magic
    w32(I1 +  4, 1);                    // inode = 1
    w16(I1 +  8, ROOT_MODE);           // mode
    w32(I1 + 12, EXT2_DIR);            // type
    w32(I1 + 20, BLOCK_SZ);            // size = 1024 (2 blocks)
    w16(I1 + 42, 2);                    // nlinks = 2
    w16(I1 + 44, 2);                    // nblocks = BLOCKS_TO_SECTORS(1) = 2 = 4
    w16(I1 + 48, EXT2_OS_JSOS);        // osd1
    w32(I1 + 52, root_dir_sector);     // blocks[0] = sector of root dir block

    // === 6. Root directory block (at root_dir_off) =======================
    //
    // On-disk dirent layout (Aqeous format):
    //   +0  uint32_t ino
    //   +4  uint16_t rec_len
    //   +6  uint8_t  name_len
    //   +7  uint8_t  file_type
    //   +8  char     name[name_len+1]   (NUL-terminated)
    //
    // ext2_add_file_to_dir computes:
    //   rec_len = 4 + 2 + 1 + 1 + name_len + 1 = 9 + name_len

    const EXT2_HARDLINK = 8;

    // Entry 0: "."
    let D = root_dir_off;
    w32(D + 0, 1);                      // ino = root inode (1)
    w16(D + 4, 10);                     // rec_len = 9 + 1 = 10
    w8 (D + 6, 1);                      // name_len = 1
    w8 (D + 7, EXT2_HARDLINK);         // file_type = EXT2_HARDLINK
    wstr(D + 8, ".");                   // name = "." + NUL
    buf[D + 9] = 0;                     // explicit NUL

    // Entry 1: ".." — last entry in the directory block.
    //
    // IMPORTANT: Aqeous's ext2_dirent_from_dir() terminates iteration by
    // checking if rec_len at the NEXT position is zero.  It does NOT check
    // whether the offset exceeds the block size.  If we pad rec_len to fill
    // the block (standard EXT2 practice: 1024 - 10 = 1014), the next check
    // position lands at offset 1024+4 = 1028, PAST the kmalloc'd buffer,
    // reading heap garbage and potentially returning a spurious dirent.
    //
    // Instead, keep rec_len at its natural size (9 + name_len = 11).  The
    // termination check then reads offset 21+4 = 25, which is inside the
    // zeroed remainder of the block and correctly returns 0 → NULL.
    D = root_dir_off + 10;
    w32(D + 0, 1);                      // ino = root inode (1)  (root's parent is itself)
    w16(D + 4, 11);                     // rec_len = 9 + 2 = 11 (natural size)
    w8 (D + 6, 2);                      // name_len = 2
    w8 (D + 7, EXT2_HARDLINK);         // file_type = EXT2_HARDLINK
    wstr(D + 8, "..");                  // name = ".." + NUL
    buf[D + 10] = 0;                    // explicit NUL

    // Remaining bytes of the block (offsets 21-1023) are already zero.
    // The dirent walker checks rec_len at offset 25 → finds 0 → returns NULL.

    dbg_log("EXT2: Formatted " + (size >> 20) + "MB virtual disk (" + total_blocks +
            " blocks, root dir at sector " + root_dir_sector + ")", LOG_DISK);
}

/**
 * RAM-based Virtual Disk
 * 
 * Stores disk data in memory (non-persistent)
 */
export class RAMVirtualDisk extends VirtualDisk {
    constructor(size = DEFAULT_DISK_SIZE) {
        super(size);
        this.disk_type = DISK_TYPE_RAM;
        this.data = new Uint8Array(size);
        
        // Pre-format with a minimal EXT2 filesystem so Aqeous's ext2_initialize()
        // finds a valid superblock + root directory instead of crashing on a blank disk.
        format_ext2(this.data, size);
        
        dbg_log("RAM Virtual Disk created: " + Math.round(size / (1024*1024)) + "MB", LOG_DISK);
    }
    
    async read_sectors(lba, count) {
        if (!this.validate_range(lba, count)) {
            throw new Error("Invalid LBA range: " + lba + "+" + count);
        }
        
        this.update_access_time();
        
        const start_byte = lba * this.sector_size;
        const length = count * this.sector_size;
        
        const result = new Uint8Array(length);
        result.set(this.data.subarray(start_byte, start_byte + length));
        
        dbg_log("RAM Disk read: LBA=" + lba + " count=" + count + " bytes=" + length, LOG_DISK);
        return result;
    }
    
    async write_sectors(lba, data) {
        if (this.read_only) {
            throw new Error("Disk is read-only");
        }
        
        const count = Math.floor(data.length / this.sector_size);
        if (!this.validate_range(lba, count)) {
            throw new Error("Invalid LBA range: " + lba + "+" + count);
        }
        
        this.update_access_time();
        
        const start_byte = lba * this.sector_size;
        const length = count * this.sector_size;
        
        this.data.set(data.subarray(0, length), start_byte);
        
        dbg_log("RAM Disk write: LBA=" + lba + " count=" + count + " bytes=" + length, LOG_DISK);
        return count;
    }
    
    /**
     * Fill disk with pattern (useful for testing)
     * @param {number} pattern - Byte pattern to fill with
     */
    fill_pattern(pattern = 0) {
        this.data.fill(pattern);
        dbg_log("RAM Disk filled with pattern " + h(pattern), LOG_DISK);
    }
    
    /**
     * Load disk image from buffer
     * @param {Uint8Array} buffer - Disk image data
     */
    load_from_buffer(buffer) {
        const copy_size = Math.min(buffer.length, this.data.length);
        this.data.set(buffer.subarray(0, copy_size));
        
        dbg_log("RAM Disk loaded " + copy_size + " bytes from buffer", LOG_DISK);
    }
}

/**
 * Buffer-based Virtual Disk
 * 
 * Uses an existing buffer as disk storage
 */
export class BufferVirtualDisk extends VirtualDisk {
    constructor(buffer) {
        super(buffer.length);
        this.disk_type = DISK_TYPE_BUFFER;
        this.data = buffer;
        
        dbg_log("Buffer Virtual Disk created: " + Math.round(buffer.length / (1024*1024)) + "MB", LOG_DISK);
    }
    
    async read_sectors(lba, count) {
        if (!this.validate_range(lba, count)) {
            throw new Error("Invalid LBA range: " + lba + "+" + count);
        }
        
        this.update_access_time();
        
        const start_byte = lba * this.sector_size;
        const length = count * this.sector_size;
        
        const result = new Uint8Array(length);
        result.set(this.data.subarray(start_byte, start_byte + length));
        
        return result;
    }
    
    async write_sectors(lba, data) {
        if (this.read_only) {
            throw new Error("Disk is read-only");
        }
        
        const count = Math.floor(data.length / this.sector_size);
        if (!this.validate_range(lba, count)) {
            throw new Error("Invalid LBA range: " + lba + "+" + count);
        }
        
        this.update_access_time();
        
        const start_byte = lba * this.sector_size;
        const length = count * this.sector_size;
        
        this.data.set(data.subarray(0, length), start_byte);
        
        return count;
    }
}

/**
 * Durable Object Virtual Disk
 * 
 * Stores disk data in Cloudflare Durable Objects for persistence
 */
export class DurableObjectVirtualDisk extends VirtualDisk {
    constructor(durable_object_id, size = DEFAULT_DISK_SIZE) {
        super(size);
        this.disk_type = DISK_TYPE_DURABLE;
        this.durable_object_id = durable_object_id;
        this.cache = new Map(); // LRU cache for frequently accessed blocks
        this.cache_size = 1024; // Cache up to 1024 sectors (512KB)
        this.dirty_blocks = new Set(); // Track modified blocks
        this.pending_writes = new Map(); // Track pending write operations
        
        dbg_log("Durable Object Virtual Disk created: ID=" + durable_object_id + 
               " size=" + Math.round(size / (1024*1024)) + "MB", LOG_DISK);
    }
    
    async read_sectors(lba, count) {
        if (!this.validate_range(lba, count)) {
            throw new Error("Invalid LBA range: " + lba + "+" + count);
        }
        
        this.update_access_time();
        
        const result = new Uint8Array(count * this.sector_size);
        let result_offset = 0;
        
        // Read sector by sector, using cache when possible
        for (let i = 0; i < count; i++) {
            const sector_lba = lba + i;
            const sector_data = await this.read_single_sector(sector_lba);
            result.set(sector_data, result_offset);
            result_offset += this.sector_size;
        }
        
        dbg_log("Durable Object read: LBA=" + lba + " count=" + count, LOG_DISK);
        return result;
    }
    
    async write_sectors(lba, data) {
        if (this.read_only) {
            throw new Error("Disk is read-only");
        }
        
        const count = Math.floor(data.length / this.sector_size);
        if (!this.validate_range(lba, count)) {
            throw new Error("Invalid LBA range: " + lba + "+" + count);
        }
        
        this.update_access_time();
        
        // Write sector by sector to cache and mark dirty
        for (let i = 0; i < count; i++) {
            const sector_lba = lba + i;
            const sector_offset = i * this.sector_size;
            const sector_data = data.subarray(sector_offset, sector_offset + this.sector_size);
            
            await this.write_single_sector(sector_lba, sector_data);
        }
        
        dbg_log("Durable Object write: LBA=" + lba + " count=" + count, LOG_DISK);
        return count;
    }
    
    /**
     * Read a single sector, using cache if available
     * @param {number} lba - Sector LBA
     * @returns {Promise<Uint8Array>} Sector data
     */
    async read_single_sector(lba) {
        // Check cache first
        if (this.cache.has(lba)) {
            const cached_data = this.cache.get(lba);
            // Move to end (LRU)
            this.cache.delete(lba);
            this.cache.set(lba, cached_data);
            return new Uint8Array(cached_data);
        }
        
        // Not in cache, read from Durable Object
        const sector_data = await this.read_from_durable_object(lba);
        
        // Add to cache
        this.add_to_cache(lba, sector_data);
        
        return sector_data;
    }
    
    /**
     * Write a single sector to cache and mark dirty
     * @param {number} lba - Sector LBA
     * @param {Uint8Array} data - Sector data
     */
    async write_single_sector(lba, data) {
        // Update cache
        this.cache.set(lba, new Uint8Array(data));
        
        // Mark as dirty for later flush
        this.dirty_blocks.add(lba);
        
        // Evict oldest entries if cache is full
        this.evict_cache_if_needed();
        
        // For write-through behavior, could also write to DO immediately:
        // await this.write_to_durable_object(lba, data);
    }
    
    /**
     * Add sector to cache with LRU eviction
     * @param {number} lba - Sector LBA
     * @param {Uint8Array} data - Sector data
     */
    add_to_cache(lba, data) {
        // Add new entry
        this.cache.set(lba, new Uint8Array(data));
        
        // Evict if necessary
        this.evict_cache_if_needed();
    }
    
    /**
     * Evict cache entries if over limit
     */
    evict_cache_if_needed() {
        while (this.cache.size > this.cache_size) {
            // Remove oldest entry (first in map)
            const oldest_lba = this.cache.keys().next().value;
            
            // If it's dirty, we should flush it first
            if (this.dirty_blocks.has(oldest_lba)) {
                // Schedule async write but don't wait
                this.write_to_durable_object(oldest_lba, this.cache.get(oldest_lba))
                    .catch(error => {
                        dbg_log("Durable Object background write failed: " + error.message, LOG_DISK);
                    });
                this.dirty_blocks.delete(oldest_lba);
            }
            
            this.cache.delete(oldest_lba);
        }
    }
    
    /**
     * Read sector from Durable Object
     * @param {number} lba - Sector LBA
     * @returns {Promise<Uint8Array>} Sector data
     */
    async read_from_durable_object(lba) {
        // Simulate Durable Object read
        // In a real implementation, this would make a request to a Durable Object
        return new Promise((resolve) => {
            setTimeout(() => {
                // Simulate some data pattern
                const data = new Uint8Array(this.sector_size);
                for (let i = 0; i < this.sector_size; i++) {
                    data[i] = ((lba * this.sector_size + i) & 0xFF);
                }
                resolve(data);
            }, 1); // 1ms simulated latency
        });
    }
    
    /**
     * Write sector to Durable Object
     * @param {number} lba - Sector LBA
     * @param {Uint8Array} data - Sector data
     * @returns {Promise<void>}
     */
    async write_to_durable_object(lba, data) {
        // Simulate Durable Object write
        // In a real implementation, this would make a request to a Durable Object
        return new Promise((resolve) => {
            setTimeout(() => {
                dbg_log("Durable Object: Wrote sector " + lba, LOG_DISK);
                resolve();
            }, 2); // 2ms simulated latency
        });
    }
    
    /**
     * Flush all dirty blocks to persistent storage
     */
    async flush() {
        const dirty_lbas = Array.from(this.dirty_blocks);
        
        if (dirty_lbas.length === 0) {
            return; // Nothing to flush
        }
        
        dbg_log("Durable Object flush: " + dirty_lbas.length + " dirty blocks", LOG_DISK);
        
        // Write all dirty blocks in parallel
        const write_promises = dirty_lbas.map(lba => {
            const sector_data = this.cache.get(lba);
            if (sector_data) {
                return this.write_to_durable_object(lba, sector_data);
            }
            return Promise.resolve();
        });
        
        await Promise.all(write_promises);
        
        // Clear dirty set
        this.dirty_blocks.clear();
        
        dbg_log("Durable Object flush completed", LOG_DISK);
    }
    
    /**
     * Get cache statistics
     */
    get_cache_stats() {
        return {
            cache_entries: this.cache.size,
            cache_limit: this.cache_size,
            dirty_blocks: this.dirty_blocks.size,
            hit_ratio: this.cache_hits / (this.cache_hits + this.cache_misses) || 0,
        };
    }
}

/**
 * Virtual Disk Manager
 * 
 * Manages multiple virtual disks for AHCI ports
 */
export class VirtualDiskManager {
    constructor() {
        this.disks = new Map(); // port -> VirtualDisk
        this.default_disk_size = DEFAULT_DISK_SIZE;
        
        dbg_log("Virtual Disk Manager initialized", LOG_DISK);
    }
    
    /**
     * Create a virtual disk for a port
     * @param {number} port - Port number
     * @param {string} type - Disk type (ram, durable, buffer, file)
     * @param {Object} options - Disk options
     * @returns {VirtualDisk} Created disk
     */
    create_disk(port, type = DISK_TYPE_RAM, options = {}) {
        let disk;
        
        const size = options.size || this.default_disk_size;
        
        switch (type) {
            case DISK_TYPE_RAM:
                disk = new RAMVirtualDisk(size);
                break;
                
            case DISK_TYPE_DURABLE:
                const do_id = options.durable_object_id || ("disk_port_" + port);
                disk = new DurableObjectVirtualDisk(do_id, size);
                break;
                
            case DISK_TYPE_BUFFER:
                if (!options.buffer) {
                    throw new Error("Buffer must be provided for buffer disk");
                }
                disk = new BufferVirtualDisk(options.buffer);
                break;
                
            default:
                throw new Error("Unsupported disk type: " + type);
        }
        
        if (options.read_only) {
            disk.read_only = true;
        }
        
        this.disks.set(port, disk);
        
        dbg_log("Virtual Disk Manager: Created " + type + " disk for port " + port, LOG_DISK);
        return disk;
    }
    
    /**
     * Get virtual disk for a port
     * @param {number} port - Port number
     * @returns {VirtualDisk|null} Virtual disk or null if not found
     */
    get_disk(port) {
        return this.disks.get(port) || null;
    }
    
    /**
     * Remove virtual disk for a port
     * @param {number} port - Port number
     */
    remove_disk(port) {
        const disk = this.disks.get(port);
        if (disk) {
            // Flush any pending data
            disk.flush().catch(error => {
                dbg_log("Error flushing disk during removal: " + error.message, LOG_DISK);
            });
        }
        
        this.disks.delete(port);
        dbg_log("Virtual Disk Manager: Removed disk for port " + port, LOG_DISK);
    }
    
    /**
     * Flush all disks
     */
    async flush_all() {
        const flush_promises = [];
        
        for (const [port, disk] of this.disks) {
            flush_promises.push(
                disk.flush().catch(error => {
                    dbg_log("Error flushing disk port " + port + ": " + error.message, LOG_DISK);
                })
            );
        }
        
        await Promise.all(flush_promises);
        dbg_log("Virtual Disk Manager: Flushed all disks", LOG_DISK);
    }
    
    /**
     * Get statistics for all disks
     */
    get_stats() {
        const stats = {
            total_disks: this.disks.size,
            disk_info: {},
        };
        
        for (const [port, disk] of this.disks) {
            stats.disk_info[port] = disk.get_info();
        }
        
        return stats;
    }
    
    /**
     * Load disk from settings
     * @param {number} port - Port number
     * @param {Object} settings - Disk settings
     */
    load_disk_from_settings(port, settings) {
        if (!settings) {
            // Create default RAM disk
            return this.create_disk(port, DISK_TYPE_RAM);
        }
        
        const type = settings.type || DISK_TYPE_RAM;
        const options = {
            size: settings.size,
            read_only: settings.read_only,
            buffer: settings.buffer,
            durable_object_id: settings.durable_object_id,
        };
        
        return this.create_disk(port, type, options);
    }
}

// (classes already exported above via `export class`)
