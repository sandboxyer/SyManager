#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>
#include <unistd.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <time.h>
#include <errno.h>
#include <fcntl.h>

// ==================== CONSTANTS AND CONFIGURATION ====================

#define MAX_NAME_LENGTH 256
#define MAX_FIELD_LENGTH 64
#define MAX_FIELDS 32
#define MAX_PATH_LENGTH 1024
#define MAX_LINE_LENGTH 4096
#define UUID_SIZE 37
#define SYDB_BASE_DIRECTORY "/var/lib/sydb"
#define LOCK_TIMEOUT 30
#define DATA_FILE_EXTENSION ".sydb"
#define FILE_MAGIC 0x53594442 // "SYDB" in hex
#define FILE_VERSION 1

typedef enum {
    TYPE_STRING,
    TYPE_INT,
    TYPE_FLOAT,
    TYPE_BOOL,
    TYPE_ARRAY,
    TYPE_OBJECT,
    TYPE_NULL
} field_type_t;

// ==================== BINARY DATA STRUCTURES ====================

typedef struct {
    char name[MAX_FIELD_LENGTH];
    field_type_t type;
    bool required;
} field_schema_t;

typedef struct {
    char uuid[UUID_SIZE];
    char *data;
    size_t data_length;
} instance_t;

// Binary file header
typedef struct {
    uint32_t magic;
    uint32_t version;
    uint64_t record_count;
    uint64_t file_size;
    uint64_t free_offset;
    uint32_t schema_crc;
    uint8_t reserved[100];
} file_header_t;

// Binary record header
typedef struct {
    uint64_t data_size;
    uint64_t timestamp;
    uint32_t flags;
    uint32_t data_crc;
    char uuid[UUID_SIZE];
    uint8_t reserved[28];
} record_header_t;

// ==================== UTILITY FUNCTIONS ====================

void generate_uuid(char *uuid) {
    const char *chars = "0123456789abcdef";
    int segments[] = {8, 4, 4, 4, 12};
    int pos = 0;
    
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    unsigned int seed = (unsigned int)(ts.tv_nsec ^ ts.tv_sec ^ getpid());
    
    for (int i = 0; i < 5; i++) {
        if (i > 0) uuid[pos++] = '-';
        for (int j = 0; j < segments[i]; j++) {
            uuid[pos++] = chars[rand_r(&seed) % 16];
        }
    }
    uuid[pos] = '\0';
}

int create_directory(const char *path) {
    struct stat st;
    if (stat(path, &st) == -1) {
        // Create parent directories recursively
        char tmp[MAX_PATH_LENGTH];
        char *p = NULL;
        size_t len;
        
        snprintf(tmp, sizeof(tmp), "%s", path);
        len = strlen(tmp);
        if (tmp[len - 1] == '/') {
            tmp[len - 1] = 0;
        }
        
        for (p = tmp + 1; *p; p++) {
            if (*p == '/') {
                *p = 0;
                if (mkdir(tmp, 0755) == -1 && errno != EEXIST) {
                    fprintf(stderr, "Error creating directory %s: %s\n", tmp, strerror(errno));
                    return -1;
                }
                *p = '/';
            }
        }
        
        if (mkdir(tmp, 0755) == -1 && errno != EEXIST) {
            fprintf(stderr, "Error creating directory %s: %s\n", tmp, strerror(errno));
            return -1;
        }
    }
    return 0;
}

int acquire_lock(const char *lock_file) {
    int fd = open(lock_file, O_CREAT | O_RDWR, 0644);
    if (fd == -1) {
        fprintf(stderr, "Error creating lock file %s: %s\n", lock_file, strerror(errno));
        return -1;
    }
    
    struct timespec timeout;
    clock_gettime(CLOCK_REALTIME, &timeout);
    timeout.tv_sec += LOCK_TIMEOUT;
    
    if (flock(fd, LOCK_EX | LOCK_NB) == -1) {
        if (errno == EWOULDBLOCK) {
            fprintf(stderr, "Timeout: Could not acquire lock on %s after %d seconds\n", 
                    lock_file, LOCK_TIMEOUT);
            close(fd);
            return -1;
        }
    }
    
    return fd;
}

void release_lock(int fd, const char *lock_file) {
    if (fd != -1) {
        flock(fd, LOCK_UN);
        close(fd);
    }
}

char* get_sydb_base_directory() {
    static char base_dir[MAX_PATH_LENGTH];
    const char *env_dir = getenv("SYDB_BASE_DIR");
    if (env_dir) {
        strncpy(base_dir, env_dir, MAX_PATH_LENGTH - 1);
        base_dir[MAX_PATH_LENGTH - 1] = '\0';
    } else {
        strncpy(base_dir, SYDB_BASE_DIRECTORY, MAX_PATH_LENGTH - 1);
        base_dir[MAX_PATH_LENGTH - 1] = '\0';
    }
    return base_dir;
}

// ==================== BINARY FILE OPERATIONS ====================

uint32_t compute_crc32(const void *data, size_t length) {
    const uint8_t *bytes = (const uint8_t *)data;
    uint32_t crc = 0xFFFFFFFF;
    
    for (size_t i = 0; i < length; i++) {
        crc ^= bytes[i];
        for (int j = 0; j < 8; j++) {
            crc = (crc >> 1) ^ (0xEDB88320 & -(crc & 1));
        }
    }
    
    return ~crc;
}

FILE* open_data_file(const char *database_name, const char *collection_name, const char *mode) {
    char path[MAX_PATH_LENGTH];
    snprintf(path, MAX_PATH_LENGTH, "%s/%s/%s/data%s", 
             get_sydb_base_directory(), database_name, collection_name, DATA_FILE_EXTENSION);
    
    FILE *file = fopen(path, mode);
    if (!file && strcmp(mode, "r+b") == 0) {
        file = fopen(path, "w+b");
    }
    return file;
}

int initialize_data_file(FILE *file) {
    file_header_t header = {
        .magic = FILE_MAGIC,
        .version = FILE_VERSION,
        .record_count = 0,
        .file_size = sizeof(file_header_t),
        .free_offset = sizeof(file_header_t),
        .schema_crc = 0
    };
    memset(header.reserved, 0, sizeof(header.reserved));
    
    if (fseek(file, 0, SEEK_SET) != 0) return -1;
    if (fwrite(&header, sizeof(header), 1, file) != 1) return -1;
    return 0;
}

int read_file_header(FILE *file, file_header_t *header) {
    if (fseek(file, 0, SEEK_SET) != 0) return -1;
    if (fread(header, sizeof(file_header_t), 1, file) != 1) return -1;
    
    if (header->magic != FILE_MAGIC) {
        return -1;
    }
    
    return 0;
}

int write_file_header(FILE *file, file_header_t *header) {
    if (fseek(file, 0, SEEK_SET) != 0) return -1;
    if (fwrite(header, sizeof(file_header_t), 1, file) != 1) return -1;
    return 0;
}

int append_record(FILE *file, const char *uuid, const char *json_data) {
    file_header_t header;
    if (read_file_header(file, &header) == -1) {
        if (initialize_data_file(file) == -1) return -1;
        if (read_file_header(file, &header) == -1) return -1;
    }
    
    size_t data_len = strlen(json_data);
    size_t total_size = sizeof(record_header_t) + data_len + 1;
    
    if (header.free_offset + total_size > header.file_size) {
        header.file_size = header.free_offset + total_size + 1024;
        if (write_file_header(file, &header) == -1) return -1;
    }
    
    if (fseek(file, header.free_offset, SEEK_SET) != 0) return -1;
    
    record_header_t rec_header = {
        .data_size = data_len,
        .timestamp = time(NULL),
        .flags = 0,
        .data_crc = compute_crc32(json_data, data_len)
    };
    strncpy(rec_header.uuid, uuid, UUID_SIZE - 1);
    rec_header.uuid[UUID_SIZE - 1] = '\0';
    memset(rec_header.reserved, 0, sizeof(rec_header.reserved));
    
    if (fwrite(&rec_header, sizeof(record_header_t), 1, file) != 1) return -1;
    if (fwrite(json_data, data_len + 1, 1, file) != 1) return -1;
    
    header.record_count++;
    header.free_offset += total_size;
    
    if (write_file_header(file, &header) == -1) return -1;
    
    return 0;
}

typedef struct {
    FILE *file;
    uint64_t current_offset;
    uint64_t records_processed;
} record_iterator_t;

record_iterator_t* create_record_iterator(FILE *file) {
    file_header_t header;
    if (read_file_header(file, &header) == -1) return NULL;
    
    record_iterator_t *iter = malloc(sizeof(record_iterator_t));
    if (!iter) return NULL;
    
    iter->file = file;
    iter->current_offset = sizeof(file_header_t);
    iter->records_processed = 0;
    
    return iter;
}

void free_record_iterator(record_iterator_t *iter) {
    free(iter);
}

int read_next_record(record_iterator_t *iter, record_header_t *header, char **json_data) {
    file_header_t file_header;
    if (read_file_header(iter->file, &file_header) == -1) return -1;
    
    if (iter->records_processed >= file_header.record_count) return 0;
    
    if (fseek(iter->file, iter->current_offset, SEEK_SET) != 0) return -1;
    
    if (fread(header, sizeof(record_header_t), 1, iter->file) != 1) return -1;
    
    *json_data = malloc(header->data_size + 1);
    if (!*json_data) return -1;
    
    if (fread(*json_data, header->data_size + 1, 1, iter->file) != 1) {
        free(*json_data);
        return -1;
    }
    
    uint32_t computed_crc = compute_crc32(*json_data, header->data_size);
    if (computed_crc != header->data_crc) {
        free(*json_data);
        return -1;
    }
    
    iter->current_offset += sizeof(record_header_t) + header->data_size + 1;
    iter->records_processed++;
    
    return 1;
}

// ==================== JSON-LIKE PARSING ====================

char* json_get_string(const char *json, const char *key) {
    char pattern[256];
    snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
    char *start = strstr(json, pattern);
    if (!start) return NULL;
    
    start += strlen(pattern);
    char *end = strchr(start, '"');
    if (!end) return NULL;
    
    size_t len = end - start;
    char *result = malloc(len + 1);
    if (!result) return NULL;
    
    strncpy(result, start, len);
    result[len] = '\0';
    return result;
}

int json_get_int(const char *json, const char *key) {
    char pattern[256];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    char *start = strstr(json, pattern);
    if (!start) return 0;
    
    start += strlen(pattern);
    return atoi(start);
}

bool json_has_field(const char *json, const char *key) {
    char pattern[256];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    return strstr(json, pattern) != NULL;
}

bool json_matches_query(const char *json, const char *query) {
    if (!query || !json) return false;
    
    char query_copy[1024];
    strncpy(query_copy, query, sizeof(query_copy) - 1);
    query_copy[sizeof(query_copy) - 1] = '\0';
    
    char *token = strtok(query_copy, ",");
    while (token) {
        while (*token == ' ') token++;
        
        char *colon = strchr(token, ':');
        if (!colon) {
            token = strtok(NULL, ",");
            continue;
        }
        
        *colon = '\0';
        char *field_name = token;
        char *expected_value = colon + 1;
        
        if (expected_value[0] == '"' && expected_value[strlen(expected_value)-1] == '"') {
            expected_value[strlen(expected_value)-1] = '\0';
            expected_value++;
        }
        
        char *actual_string_value = json_get_string(json, field_name);
        if (actual_string_value) {
            bool matches = (strcmp(actual_string_value, expected_value) == 0);
            free(actual_string_value);
            if (!matches) return false;
        } else {
            int actual_int_value = json_get_int(json, field_name);
            int expected_int_value = atoi(expected_value);
            if (actual_int_value != expected_int_value) {
                return false;
            }
        }
        
        token = strtok(NULL, ",");
    }
    
    return true;
}

// ==================== SCHEMA PARSING AND VALIDATION ====================

field_type_t parse_field_type(const char *type_string) {
    if (strcmp(type_string, "string") == 0) return TYPE_STRING;
    if (strcmp(type_string, "int") == 0) return TYPE_INT;
    if (strcmp(type_string, "float") == 0) return TYPE_FLOAT;
    if (strcmp(type_string, "bool") == 0) return TYPE_BOOL;
    if (strcmp(type_string, "array") == 0) return TYPE_ARRAY;
    if (strcmp(type_string, "object") == 0) return TYPE_OBJECT;
    return TYPE_NULL;
}

const char* field_type_to_string(field_type_t type) {
    switch (type) {
        case TYPE_STRING: return "string";
        case TYPE_INT: return "int";
        case TYPE_FLOAT: return "float";
        case TYPE_BOOL: return "bool";
        case TYPE_ARRAY: return "array";
        case TYPE_OBJECT: return "object";
        default: return "null";
    }
}

int parse_schema_fields(int argc, char *argv[], int start_index, 
                       field_schema_t *fields, int *field_count) {
    *field_count = 0;
    
    for (int i = start_index; i < argc && *field_count < MAX_FIELDS; i++) {
        char *field_spec = argv[i];
        if (strncmp(field_spec, "--", 2) != 0) continue;
        
        field_spec += 2;
        
        char field_name[MAX_FIELD_LENGTH];
        char type_string[32];
        bool required = false;
        
        char *first_dash = strchr(field_spec, '-');
        if (!first_dash) continue;
        
        *first_dash = '\0';
        strncpy(field_name, field_spec, MAX_FIELD_LENGTH - 1);
        field_name[MAX_FIELD_LENGTH - 1] = '\0';
        
        char *second_dash = strchr(first_dash + 1, '-');
        if (second_dash) {
            *second_dash = '\0';
            strncpy(type_string, first_dash + 1, sizeof(type_string) - 1);
            type_string[sizeof(type_string) - 1] = '\0';
            required = (strcmp(second_dash + 1, "req") == 0);
        } else {
            strncpy(type_string, first_dash + 1, sizeof(type_string) - 1);
            type_string[sizeof(type_string) - 1] = '\0';
            required = false;
        }
        
        field_type_t type = parse_field_type(type_string);
        if (type == TYPE_NULL) {
            fprintf(stderr, "Error: Unknown field type '%s' for field '%s'\n", 
                    type_string, field_name);
            return -1;
        }
        
        strncpy(fields[*field_count].name, field_name, MAX_FIELD_LENGTH - 1);
        fields[*field_count].name[MAX_FIELD_LENGTH - 1] = '\0';
        fields[*field_count].type = type;
        fields[*field_count].required = required;
        (*field_count)++;
    }
    
    return 0;
}

int load_schema(const char *database_name, const char *collection_name, 
                field_schema_t *fields, int *field_count) {
    char schema_path[MAX_PATH_LENGTH];
    snprintf(schema_path, MAX_PATH_LENGTH, "%s/%s/%s/schema.txt", 
             get_sydb_base_directory(), database_name, collection_name);
    
    FILE *file = fopen(schema_path, "r");
    if (!file) {
        fprintf(stderr, "Error: Cannot load schema for collection '%s'\n", collection_name);
        return -1;
    }
    
    *field_count = 0;
    char line[256];
    
    while (fgets(line, sizeof(line), file) && *field_count < MAX_FIELDS) {
        line[strcspn(line, "\n")] = '\0';
        
        char *first_colon = strchr(line, ':');
        char *second_colon = first_colon ? strchr(first_colon + 1, ':') : NULL;
        
        if (!first_colon || !second_colon) continue;
        
        *first_colon = '\0';
        *second_colon = '\0';
        
        char *field_name = line;
        char *type_string = first_colon + 1;
        char *required_string = second_colon + 1;
        
        strncpy(fields[*field_count].name, field_name, MAX_FIELD_LENGTH - 1);
        fields[*field_count].name[MAX_FIELD_LENGTH - 1] = '\0';
        fields[*field_count].type = parse_field_type(type_string);
        fields[*field_count].required = (strcmp(required_string, "required") == 0);
        (*field_count)++;
    }
    
    fclose(file);
    return 0;
}

bool validate_field_value(const char *field_name, const char *value, field_type_t type) {
    if (!value || strlen(value) == 0) {
        return true;
    }
    
    switch (type) {
        case TYPE_INT: {
            char *end_ptr;
            long int_value = strtol(value, &end_ptr, 10);
            if (*end_ptr != '\0') {
                fprintf(stderr, "Validation error: Field '%s' should be integer but got '%s'\n", 
                        field_name, value);
                return false;
            }
            return true;
        }
        case TYPE_FLOAT: {
            char *end_ptr;
            double float_value = strtod(value, &end_ptr);
            if (*end_ptr != '\0') {
                fprintf(stderr, "Validation error: Field '%s' should be float but got '%s'\n", 
                        field_name, value);
                return false;
            }
            return true;
        }
        case TYPE_BOOL: {
            if (strcmp(value, "true") != 0 && strcmp(value, "false") != 0 &&
                strcmp(value, "1") != 0 && strcmp(value, "0") != 0) {
                fprintf(stderr, "Validation error: Field '%s' should be boolean but got '%s'\n", 
                        field_name, value);
                return false;
            }
            return true;
        }
        case TYPE_STRING:
        case TYPE_ARRAY:
        case TYPE_OBJECT:
        case TYPE_NULL:
        default:
            return true;
    }
}

int validate_instance_against_schema(const char *instance_json, 
                                    field_schema_t *fields, int field_count) {
    for (int i = 0; i < field_count; i++) {
        if (fields[i].required && !json_has_field(instance_json, fields[i].name)) {
            fprintf(stderr, "Validation error: Required field '%s' is missing\n", 
                    fields[i].name);
            return -1;
        }
        
        if (json_has_field(instance_json, fields[i].name)) {
            char *value = json_get_string(instance_json, fields[i].name);
            if (value) {
                if (!validate_field_value(fields[i].name, value, fields[i].type)) {
                    free(value);
                    return -1;
                }
                free(value);
            }
        }
    }
    return 0;
}

void print_schema(const char *database_name, const char *collection_name) {
    field_schema_t fields[MAX_FIELDS];
    int field_count = 0;
    
    if (load_schema(database_name, collection_name, fields, &field_count) == -1) {
        fprintf(stderr, "Error: Cannot load schema for collection '%s'\n", collection_name);
        return;
    }
    
    printf("Schema for collection '%s':\n", collection_name);
    printf("%-20s %-10s %-10s\n", "Field", "Type", "Required");
    printf("----------------------------------------\n");
    
    for (int i = 0; i < field_count; i++) {
        printf("%-20s %-10s %-10s\n", 
               fields[i].name, 
               field_type_to_string(fields[i].type),
               fields[i].required ? "Yes" : "No");
    }
}

// ==================== DATABASE OPERATIONS ====================

int database_create(const char *database_name) {
    char base_dir[MAX_PATH_LENGTH];
    strncpy(base_dir, get_sydb_base_directory(), MAX_PATH_LENGTH - 1);
    base_dir[MAX_PATH_LENGTH - 1] = '\0';
    
    if (create_directory(base_dir) == -1) {
        return -1;
    }
    
    char db_path[MAX_PATH_LENGTH];
    snprintf(db_path, MAX_PATH_LENGTH, "%s/%s", base_dir, database_name);
    
    if (create_directory(db_path) == -1) {
        return -1;
    }
    
    printf("Database '%s' created successfully at %s\n", database_name, db_path);
    return 0;
}

int database_exists(const char *database_name) {
    char db_path[MAX_PATH_LENGTH];
    snprintf(db_path, MAX_PATH_LENGTH, "%s/%s", 
             get_sydb_base_directory(), database_name);
    
    struct stat st;
    return (stat(db_path, &st) == 0 && S_ISDIR(st.st_mode));
}

char** database_list(int *count) {
    char base_dir[MAX_PATH_LENGTH];
    strncpy(base_dir, get_sydb_base_directory(), MAX_PATH_LENGTH - 1);
    base_dir[MAX_PATH_LENGTH - 1] = '\0';
    
    DIR *dir = opendir(base_dir);
    if (!dir) {
        *count = 0;
        return NULL;
    }
    
    struct dirent *entry;
    int db_count = 0;
    while ((entry = readdir(dir)) != NULL) {
        if (entry->d_type == DT_DIR && 
            strcmp(entry->d_name, ".") != 0 && 
            strcmp(entry->d_name, "..") != 0) {
            db_count++;
        }
    }
    rewinddir(dir);
    
    if (db_count == 0) {
        closedir(dir);
        *count = 0;
        return NULL;
    }
    
    char **dbs = malloc(db_count * sizeof(char*));
    if (!dbs) {
        closedir(dir);
        *count = 0;
        return NULL;
    }
    
    int index = 0;
    while ((entry = readdir(dir)) != NULL && index < db_count) {
        if (entry->d_type == DT_DIR && 
            strcmp(entry->d_name, ".") != 0 && 
            strcmp(entry->d_name, "..") != 0) {
            dbs[index] = strdup(entry->d_name);
            if (!dbs[index]) {
                for (int i = 0; i < index; i++) {
                    free(dbs[i]);
                }
                free(dbs);
                closedir(dir);
                *count = 0;
                return NULL;
            }
            index++;
        }
    }
    closedir(dir);
    
    *count = db_count;
    return dbs;
}

// ==================== COLLECTION OPERATIONS ====================

int collection_create(const char *database_name, const char *collection_name, 
                     field_schema_t *fields, int field_count) {
    if (!database_exists(database_name)) {
        fprintf(stderr, "Database '%s' does not exist\n", database_name);
        return -1;
    }
    
    char db_path[MAX_PATH_LENGTH];
    snprintf(db_path, MAX_PATH_LENGTH, "%s/%s", 
             get_sydb_base_directory(), database_name);
    
    char coll_path[MAX_PATH_LENGTH];
    snprintf(coll_path, MAX_PATH_LENGTH, "%s/%s", db_path, collection_name);
    
    if (create_directory(coll_path) == -1) {
        return -1;
    }
    
    char schema_path[MAX_PATH_LENGTH];
    snprintf(schema_path, MAX_PATH_LENGTH, "%s/schema.txt", coll_path);
    
    char lock_path[MAX_PATH_LENGTH];
    snprintf(lock_path, MAX_PATH_LENGTH, "%s/.schema.lock", coll_path);
    int lock_fd = acquire_lock(lock_path);
    if (lock_fd == -1) {
        return -1;
    }
    
    FILE *file = fopen(schema_path, "w");
    if (!file) {
        fprintf(stderr, "Error creating schema file: %s\n", strerror(errno));
        release_lock(lock_fd, lock_path);
        return -1;
    }
    
    for (int i = 0; i < field_count; i++) {
        fprintf(file, "%s:%s:%s\n", 
                fields[i].name, 
                field_type_to_string(fields[i].type),
                fields[i].required ? "required" : "optional");
    }
    
    fclose(file);
    release_lock(lock_fd, lock_path);
    
    char data_path[MAX_PATH_LENGTH];
    snprintf(data_path, MAX_PATH_LENGTH, "%s/data%s", coll_path, DATA_FILE_EXTENSION);
    FILE *data_file = fopen(data_path, "w+b");
    if (data_file) {
        initialize_data_file(data_file);
        fclose(data_file);
    }
    
    printf("Collection '%s' created successfully in database '%s'\n", 
           collection_name, database_name);
    return 0;
}

int collection_exists(const char *database_name, const char *collection_name) {
    char coll_path[MAX_PATH_LENGTH];
    snprintf(coll_path, MAX_PATH_LENGTH, "%s/%s/%s", 
             get_sydb_base_directory(), database_name, collection_name);
    
    struct stat st;
    return (stat(coll_path, &st) == 0 && S_ISDIR(st.st_mode));
}

char** collection_list(const char *database_name, int *count) {
    char db_path[MAX_PATH_LENGTH];
    snprintf(db_path, MAX_PATH_LENGTH, "%s/%s", 
             get_sydb_base_directory(), database_name);
    
    DIR *dir = opendir(db_path);
    if (!dir) {
        *count = 0;
        return NULL;
    }
    
    struct dirent *entry;
    int coll_count = 0;
    while ((entry = readdir(dir)) != NULL) {
        if (entry->d_type == DT_DIR && 
            strcmp(entry->d_name, ".") != 0 && 
            strcmp(entry->d_name, "..") != 0) {
            coll_count++;
        }
    }
    rewinddir(dir);
    
    if (coll_count == 0) {
        closedir(dir);
        *count = 0;
        return NULL;
    }
    
    char **collections = malloc(coll_count * sizeof(char*));
    if (!collections) {
        closedir(dir);
        *count = 0;
        return NULL;
    }
    
    int index = 0;
    while ((entry = readdir(dir)) != NULL && index < coll_count) {
        if (entry->d_type == DT_DIR && 
            strcmp(entry->d_name, ".") != 0 && 
            strcmp(entry->d_name, "..") != 0) {
            collections[index] = strdup(entry->d_name);
            if (!collections[index]) {
                for (int i = 0; i < index; i++) {
                    free(collections[i]);
                }
                free(collections);
                closedir(dir);
                *count = 0;
                return NULL;
            }
            index++;
        }
    }
    closedir(dir);
    
    *count = coll_count;
    return collections;
}

// ==================== INSTANCE OPERATIONS ====================

char* build_instance_json(char **fields, char **values, int count) {
    char *json = malloc(MAX_LINE_LENGTH);
    if (!json) return NULL;
    
    strcpy(json, "{");
    
    for (int i = 0; i < count; i++) {
        if (i > 0) strcat(json, ",");
        
        if (values[i] == NULL || strlen(values[i]) == 0) {
            continue;
        }
        
        if ((values[i][0] == '[' && values[i][strlen(values[i])-1] == ']') ||
            (values[i][0] == '{' && values[i][strlen(values[i])-1] == '}')) {
            snprintf(json + strlen(json), MAX_LINE_LENGTH - strlen(json), 
                    "\"%s\":%s", fields[i], values[i]);
        } else {
            char *end_ptr;
            strtol(values[i], &end_ptr, 10);
            if (*end_ptr == '\0') {
                snprintf(json + strlen(json), MAX_LINE_LENGTH - strlen(json), 
                        "\"%s\":%s", fields[i], values[i]);
            } else {
                snprintf(json + strlen(json), MAX_LINE_LENGTH - strlen(json), 
                        "\"%s\":\"%s\"", fields[i], values[i]);
            }
        }
    }
    
    strcat(json, "}");
    return json;
}

int instance_insert(const char *database_name, const char *collection_name, char *instance_json) {
    if (!database_exists(database_name) || !collection_exists(database_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        return -1;
    }
    
    field_schema_t fields[MAX_FIELDS];
    int field_count = 0;
    if (load_schema(database_name, collection_name, fields, &field_count) == -1) {
        return -1;
    }
    
    if (validate_instance_against_schema(instance_json, fields, field_count) == -1) {
        fprintf(stderr, "Instance validation failed against schema\n");
        return -1;
    }
    
    char coll_path[MAX_PATH_LENGTH];
    snprintf(coll_path, MAX_PATH_LENGTH, "%s/%s/%s", 
             get_sydb_base_directory(), database_name, collection_name);
    
    char lock_path[MAX_PATH_LENGTH];
    snprintf(lock_path, MAX_PATH_LENGTH, "%s/.data.lock", coll_path);
    int lock_fd = acquire_lock(lock_path);
    if (lock_fd == -1) {
        return -1;
    }
    
    char uuid[UUID_SIZE];
    generate_uuid(uuid);
    
    char full_json[MAX_LINE_LENGTH];
    snprintf(full_json, sizeof(full_json), "{\"_id\":\"%s\",\"_created_at\":%ld,%s", 
             uuid, time(NULL), instance_json + 1);
    
    FILE *data_file = open_data_file(database_name, collection_name, "r+b");
    if (!data_file) {
        fprintf(stderr, "Error opening data file: %s\n", strerror(errno));
        release_lock(lock_fd, lock_path);
        return -1;
    }
    
    if (append_record(data_file, uuid, full_json) == -1) {
        fprintf(stderr, "Error appending record to data file\n");
        fclose(data_file);
        release_lock(lock_fd, lock_path);
        return -1;
    }
    
    fclose(data_file);
    release_lock(lock_fd, lock_path);
    
    printf("Instance inserted successfully with ID: %s\n", uuid);
    return 0;
}

char* merge_json_objects(const char *original_json, const char *update_json) {
    char update_copy[MAX_LINE_LENGTH];
    strncpy(update_copy, update_json, sizeof(update_copy) - 1);
    update_copy[sizeof(update_copy) - 1] = '\0';
    
    if (update_copy[0] == '{') {
        memmove(update_copy, update_copy + 1, strlen(update_copy));
    }
    if (update_copy[strlen(update_copy)-1] == '}') {
        update_copy[strlen(update_copy)-1] = '\0';
    }
    
    char *update_fields[MAX_FIELDS];
    char *update_values[MAX_FIELDS];
    int update_count = 0;
    
    char *token = strtok(update_copy, ",");
    while (token && update_count < MAX_FIELDS) {
        char *colon = strchr(token, ':');
        if (colon) {
            *colon = '\0';
            char *field_name = token;
            while (*field_name == ' ' || *field_name == '"') field_name++;
            char *field_name_end = field_name + strlen(field_name) - 1;
            while (field_name_end > field_name && (*field_name_end == ' ' || *field_name_end == '"')) {
                *field_name_end = '\0';
                field_name_end--;
            }
            
            char *field_value = colon + 1;
            while (*field_value == ' ') field_value++;
            
            update_fields[update_count] = strdup(field_name);
            update_values[update_count] = strdup(field_value);
            update_count++;
        }
        token = strtok(NULL, ",");
    }
    
    char original_copy[MAX_LINE_LENGTH];
    strncpy(original_copy, original_json, sizeof(original_copy) - 1);
    original_copy[sizeof(original_copy) - 1] = '\0';
    
    if (original_copy[0] == '{') {
        memmove(original_copy, original_copy + 1, strlen(original_copy));
    }
    if (original_copy[strlen(original_copy)-1] == '}') {
        original_copy[strlen(original_copy)-1] = '\0';
    }
    
    char *original_fields[MAX_FIELDS];
    char *original_values[MAX_FIELDS];
    int original_count = 0;
    
    char *orig_token = strtok(original_copy, ",");
    while (orig_token && original_count < MAX_FIELDS) {
        char *colon = strchr(orig_token, ':');
        if (colon) {
            *colon = '\0';
            char *field_name = orig_token;
            while (*field_name == ' ' || *field_name == '"') field_name++;
            char *field_name_end = field_name + strlen(field_name) - 1;
            while (field_name_end > field_name && (*field_name_end == ' ' || *field_name_end == '"')) {
                *field_name_end = '\0';
                field_name_end--;
            }
            
            char *field_value = colon + 1;
            while (*field_value == ' ') field_value++;
            
            original_fields[original_count] = strdup(field_name);
            original_values[original_count] = strdup(field_value);
            original_count++;
        }
        orig_token = strtok(NULL, ",");
    }
    
    char *merged_json = malloc(MAX_LINE_LENGTH);
    if (!merged_json) {
        for (int i = 0; i < update_count; i++) {
            free(update_fields[i]);
            free(update_values[i]);
        }
        for (int i = 0; i < original_count; i++) {
            free(original_fields[i]);
            free(original_values[i]);
        }
        return NULL;
    }
    
    strcpy(merged_json, "{");
    int fields_added = 0;
    
    for (int i = 0; i < original_count; i++) {
        bool is_updated = false;
        for (int j = 0; j < update_count; j++) {
            if (strcmp(original_fields[i], update_fields[j]) == 0) {
                is_updated = true;
                break;
            }
        }
        
        if (!is_updated) {
            if (fields_added > 0) {
                strcat(merged_json, ",");
            }
            
            char *value = original_values[i];
            if (value[0] == '"' && value[strlen(value)-1] == '"') {
                snprintf(merged_json + strlen(merged_json), MAX_LINE_LENGTH - strlen(merged_json),
                        "\"%s\":%s", original_fields[i], value);
            } else {
                char *end_ptr;
                strtol(value, &end_ptr, 10);
                if (*end_ptr == '\0') {
                    snprintf(merged_json + strlen(merged_json), MAX_LINE_LENGTH - strlen(merged_json),
                            "\"%s\":%s", original_fields[i], value);
                } else {
                    snprintf(merged_json + strlen(merged_json), MAX_LINE_LENGTH - strlen(merged_json),
                            "\"%s\":\"%s\"", original_fields[i], value);
                }
            }
            fields_added++;
        }
    }
    
    for (int i = 0; i < update_count; i++) {
        if (fields_added > 0) {
            strcat(merged_json, ",");
        }
        
        char *value = update_values[i];
        if (value[0] == '"' && value[strlen(value)-1] == '"') {
            snprintf(merged_json + strlen(merged_json), MAX_LINE_LENGTH - strlen(merged_json),
                    "\"%s\":%s", update_fields[i], value);
        } else {
            char *end_ptr;
            strtol(value, &end_ptr, 10);
            if (*end_ptr == '\0') {
                snprintf(merged_json + strlen(merged_json), MAX_LINE_LENGTH - strlen(merged_json),
                        "\"%s\":%s", update_fields[i], value);
            } else {
                snprintf(merged_json + strlen(merged_json), MAX_LINE_LENGTH - strlen(merged_json),
                        "\"%s\":\"%s\"", update_fields[i], value);
            }
        }
        fields_added++;
    }
    
    strcat(merged_json, "}");
    
    for (int i = 0; i < update_count; i++) {
        free(update_fields[i]);
        free(update_values[i]);
    }
    for (int i = 0; i < original_count; i++) {
        free(original_fields[i]);
        free(original_values[i]);
    }
    
    return merged_json;
}

int instance_update(const char *database_name, const char *collection_name, 
                   const char *query, char *update_json) {
    if (!database_exists(database_name) || !collection_exists(database_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        return -1;
    }
    
    field_schema_t fields[MAX_FIELDS];
    int field_count = 0;
    if (load_schema(database_name, collection_name, fields, &field_count) == 0) {
        char update_copy[MAX_LINE_LENGTH];
        strncpy(update_copy, update_json, sizeof(update_copy) - 1);
        update_copy[sizeof(update_copy) - 1] = '\0';
        
        if (update_copy[0] == '{') {
            memmove(update_copy, update_copy + 1, strlen(update_copy));
        }
        if (update_copy[strlen(update_copy)-1] == '}') {
            update_copy[strlen(update_copy)-1] = '\0';
        }
        
        char *update_fields[MAX_FIELDS];
        char *update_values[MAX_FIELDS];
        int update_field_count = 0;
        
        char *token = strtok(update_copy, ",");
        while (token && update_field_count < MAX_FIELDS) {
            char *colon = strchr(token, ':');
            if (colon) {
                *colon = '\0';
                char *field_name = token;
                if (field_name[0] == '"') field_name++;
                if (field_name[strlen(field_name)-1] == '"') field_name[strlen(field_name)-1] = '\0';
                
                char *field_value = colon + 1;
                
                update_fields[update_field_count] = strdup(field_name);
                update_values[update_field_count] = strdup(field_value);
                update_field_count++;
            }
            token = strtok(NULL, ",");
        }
        
        for (int i = 0; i < update_field_count; i++) {
            for (int j = 0; j < field_count; j++) {
                if (strcmp(update_fields[i], fields[j].name) == 0) {
                    if (!validate_field_value(fields[j].name, update_values[i], fields[j].type)) {
                        for (int k = 0; k < update_field_count; k++) {
                            free(update_fields[k]);
                            free(update_values[k]);
                        }
                        return -1;
                    }
                    break;
                }
            }
            free(update_fields[i]);
            free(update_values[i]);
        }
    }
    
    char coll_path[MAX_PATH_LENGTH];
    snprintf(coll_path, MAX_PATH_LENGTH, "%s/%s/%s", 
             get_sydb_base_directory(), database_name, collection_name);
    
    char lock_path[MAX_PATH_LENGTH];
    snprintf(lock_path, MAX_PATH_LENGTH, "%s/.data.lock", coll_path);
    int lock_fd = acquire_lock(lock_path);
    if (lock_fd == -1) {
        return -1;
    }
    
    char data_path[MAX_PATH_LENGTH];
    snprintf(data_path, MAX_PATH_LENGTH, "%s/data%s", coll_path, DATA_FILE_EXTENSION);
    char temp_path[MAX_PATH_LENGTH];
    snprintf(temp_path, MAX_PATH_LENGTH, "%s/data.tmp%s", coll_path, DATA_FILE_EXTENSION);
    
    FILE *source_file = fopen(data_path, "r+b");
    FILE *temp_file = fopen(temp_path, "w+b");
    if (!source_file || !temp_file) {
        fprintf(stderr, "Error opening files: %s\n", strerror(errno));
        if (source_file) fclose(source_file);
        if (temp_file) fclose(temp_file);
        release_lock(lock_fd, lock_path);
        return -1;
    }
    
    record_iterator_t *iter = create_record_iterator(source_file);
    if (!iter) {
        fclose(source_file);
        fclose(temp_file);
        release_lock(lock_fd, lock_path);
        return -1;
    }
    
    record_header_t header;
    char *json_data;
    int updated_count = 0;
    
    while (read_next_record(iter, &header, &json_data) == 1) {
        if (json_matches_query(json_data, query)) {
            char *merged_json = merge_json_objects(json_data, update_json);
            if (merged_json) {
                append_record(temp_file, header.uuid, merged_json);
                free(merged_json);
                updated_count++;
            } else {
                append_record(temp_file, header.uuid, json_data);
            }
        } else {
            append_record(temp_file, header.uuid, json_data);
        }
        free(json_data);
    }
    
    free_record_iterator(iter);
    fclose(source_file);
    fclose(temp_file);
    
    if (updated_count > 0) {
        if (rename(temp_path, data_path) == -1) {
            fprintf(stderr, "Error replacing data file: %s\n", strerror(errno));
            release_lock(lock_fd, lock_path);
            return -1;
        }
        printf("Updated %d instance(s)\n", updated_count);
    } else {
        remove(temp_path);
        printf("No instances found matching query\n");
    }
    
    release_lock(lock_fd, lock_path);
    return updated_count > 0 ? 0 : -1;
}

int instance_delete(const char *database_name, const char *collection_name, const char *query) {
    if (!database_exists(database_name) || !collection_exists(database_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        return -1;
    }
    
    char coll_path[MAX_PATH_LENGTH];
    snprintf(coll_path, MAX_PATH_LENGTH, "%s/%s/%s", 
             get_sydb_base_directory(), database_name, collection_name);
    
    char lock_path[MAX_PATH_LENGTH];
    snprintf(lock_path, MAX_PATH_LENGTH, "%s/.data.lock", coll_path);
    int lock_fd = acquire_lock(lock_path);
    if (lock_fd == -1) {
        return -1;
    }
    
    char data_path[MAX_PATH_LENGTH];
    snprintf(data_path, MAX_PATH_LENGTH, "%s/data%s", coll_path, DATA_FILE_EXTENSION);
    char temp_path[MAX_PATH_LENGTH];
    snprintf(temp_path, MAX_PATH_LENGTH, "%s/data.tmp%s", coll_path, DATA_FILE_EXTENSION);
    
    FILE *source_file = fopen(data_path, "r+b");
    FILE *temp_file = fopen(temp_path, "w+b");
    if (!source_file || !temp_file) {
        fprintf(stderr, "Error opening files: %s\n", strerror(errno));
        if (source_file) fclose(source_file);
        if (temp_file) fclose(temp_file);
        release_lock(lock_fd, lock_path);
        return -1;
    }
    
    record_iterator_t *iter = create_record_iterator(source_file);
    if (!iter) {
        fclose(source_file);
        fclose(temp_file);
        release_lock(lock_fd, lock_path);
        return -1;
    }
    
    record_header_t header;
    char *json_data;
    int deleted_count = 0;
    
    while (read_next_record(iter, &header, &json_data) == 1) {
        if (!json_matches_query(json_data, query)) {
            append_record(temp_file, header.uuid, json_data);
        } else {
            deleted_count++;
        }
        free(json_data);
    }
    
    free_record_iterator(iter);
    fclose(source_file);
    fclose(temp_file);
    
    if (deleted_count > 0) {
        if (rename(temp_path, data_path) == -1) {
            fprintf(stderr, "Error replacing data file: %s\n", strerror(errno));
            release_lock(lock_fd, lock_path);
            return -1;
        }
        printf("Deleted %d instance(s)\n", deleted_count);
    } else {
        remove(temp_path);
        printf("No instances found matching query\n");
    }
    
    release_lock(lock_fd, lock_path);
    return deleted_count > 0 ? 0 : -1;
}

char** instance_find(const char *database_name, const char *collection_name, const char *query, int *count) {
    if (!database_exists(database_name) || !collection_exists(database_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        *count = 0;
        return NULL;
    }
    
    FILE *data_file = open_data_file(database_name, collection_name, "rb");
    if (!data_file) {
        *count = 0;
        return NULL;
    }
    
    record_iterator_t *iter = create_record_iterator(data_file);
    if (!iter) {
        fclose(data_file);
        *count = 0;
        return NULL;
    }
    
    record_header_t header;
    char *json_data;
    int match_count = 0;
    
    while (read_next_record(iter, &header, &json_data) == 1) {
        if (json_matches_query(json_data, query)) {
            match_count++;
        }
        free(json_data);
    }
    
    free_record_iterator(iter);
    
    if (match_count == 0) {
        fclose(data_file);
        *count = 0;
        return NULL;
    }
    
    iter = create_record_iterator(data_file);
    char **results = malloc(match_count * sizeof(char*));
    if (!results) {
        free_record_iterator(iter);
        fclose(data_file);
        *count = 0;
        return NULL;
    }
    
    int index = 0;
    while (read_next_record(iter, &header, &json_data) == 1 && index < match_count) {
        if (json_matches_query(json_data, query)) {
            results[index] = strdup(json_data);
            if (!results[index]) {
                for (int i = 0; i < index; i++) {
                    free(results[i]);
                }
                free(results);
                free_record_iterator(iter);
                fclose(data_file);
                *count = 0;
                return NULL;
            }
            index++;
        }
        free(json_data);
    }
    
    free_record_iterator(iter);
    fclose(data_file);
    *count = index;
    return results;
}

char** instance_list(const char *database_name, const char *collection_name, int *count) {
    FILE *data_file = open_data_file(database_name, collection_name, "rb");
    if (!data_file) {
        *count = 0;
        return NULL;
    }
    
    file_header_t header;
    if (read_file_header(data_file, &header) == -1) {
        fclose(data_file);
        *count = 0;
        return NULL;
    }
    
    if (header.record_count == 0) {
        fclose(data_file);
        *count = 0;
        return NULL;
    }
    
    char **instances = malloc(header.record_count * sizeof(char*));
    if (!instances) {
        fclose(data_file);
        *count = 0;
        return NULL;
    }
    
    record_iterator_t *iter = create_record_iterator(data_file);
    if (!iter) {
        free(instances);
        fclose(data_file);
        *count = 0;
        return NULL;
    }
    
    record_header_t rec_header;
    char *json_data;
    int index = 0;
    
    while (read_next_record(iter, &rec_header, &json_data) == 1 && index < header.record_count) {
        instances[index] = strdup(json_data);
        if (!instances[index]) {
            for (int i = 0; i < index; i++) {
                free(instances[i]);
            }
            free(instances);
            free_record_iterator(iter);
            fclose(data_file);
            *count = 0;
            return NULL;
        }
        free(json_data);
        index++;
    }
    
    free_record_iterator(iter);
    fclose(data_file);
    *count = index;
    return instances;
}

// ==================== COMMAND LINE INTERFACE ====================

void print_usage() {
    printf("Usage:\n");
    printf("  sydb create <database_name>\n");
    printf("  sydb create <database_name> <model_name> --schema --<field>-<type>[-req] ...\n");
    printf("  sydb create <database_name> <model_name> --insert-one --<field>-\"<value>\" ...\n");
    printf("  sydb update <database_name> <model_name> --where \"<query>\" --set --<field>-\"<value>\" ...\n");
    printf("  sydb delete <database_name> <model_name> --where \"<query>\"\n");
    printf("  sydb find <database_name> <model_name> --where \"<query>\"\n");
    printf("  sydb schema <database_name> <model_name>\n");
    printf("  sydb list\n");
    printf("  sydb list <database_name>\n");
    printf("  sydb list <database_name> <model_name>\n");
    printf("\nField types: string, int, float, bool, array, object\n");
    printf("Add -req for required fields\n");
    printf("Query format: field:value,field2:value2 (multiple conditions supported)\n");
}

int parse_insert_data(int argc, char *argv[], int start_index, 
                     char **fields, char **values, int *count) {
    *count = 0;
    
    for (int i = start_index; i < argc && *count < MAX_FIELDS; i++) {
        char *field_spec = argv[i];
        if (strncmp(field_spec, "--", 2) != 0) continue;
        
        field_spec += 2;
        
        char *value_start = strchr(field_spec, '-');
        if (!value_start) {
            continue;
        }
        
        *value_start = '\0';
        char *field_value = value_start + 1;
        
        if (strlen(field_value) == 0) {
            fields[*count] = strdup(field_spec);
            values[*count] = strdup("");
        } else {
            if (field_value[0] == '"' && field_value[strlen(field_value)-1] == '"') {
                field_value[strlen(field_value)-1] = '\0';
                field_value++;
            }
            
            fields[*count] = strdup(field_spec);
            values[*count] = strdup(field_value);
        }
        
        if (!fields[*count] || !values[*count]) {
            for (int j = 0; j < *count; j++) {
                free(fields[j]);
                free(values[j]);
            }
            return -1;
        }
        
        (*count)++;
    }
    
    return 0;
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        print_usage();
        return 1;
    }
    
    create_directory(get_sydb_base_directory());
    
    if (strcmp(argv[1], "create") == 0) {
        if (argc < 3) {
            fprintf(stderr, "Error: Missing database name\n");
            print_usage();
            return 1;
        }
        
        if (argc == 3) {
            return database_create(argv[2]);
        }
        else if (argc >= 5) {
            int schema_index = -1;
            int insert_index = -1;
            
            for (int i = 3; i < argc; i++) {
                if (strcmp(argv[i], "--schema") == 0) {
                    schema_index = i;
                    break;
                } else if (strcmp(argv[i], "--insert-one") == 0) {
                    insert_index = i;
                    break;
                }
            }
            
            if (schema_index != -1) {
                if (schema_index != 4) {
                    fprintf(stderr, "Error: Invalid syntax. Use: sydb create <db> <collection> --schema ...\n");
                    print_usage();
                    return 1;
                }
                
                if (argc < 6) {
                    fprintf(stderr, "Error: Missing schema fields\n");
                    print_usage();
                    return 1;
                }
                
                field_schema_t fields[MAX_FIELDS];
                int field_count = 0;
                if (parse_schema_fields(argc, argv, schema_index + 1, 
                                       fields, &field_count) == -1) {
                    return 1;
                }
                
                if (field_count == 0) {
                    fprintf(stderr, "Error: No valid schema fields provided\n");
                    return 1;
                }
                
                return collection_create(argv[2], argv[3], fields, field_count);
            }
            else if (insert_index != -1) {
                if (insert_index != 4) {
                    fprintf(stderr, "Error: Invalid syntax. Use: sydb create <db> <collection> --insert-one ...\n");
                    print_usage();
                    return 1;
                }
                
                if (argc < 6) {
                    fprintf(stderr, "Error: Missing insert data\n");
                    print_usage();
                    return 1;
                }
                
                char *fields[MAX_FIELDS];
                char *values[MAX_FIELDS];
                int field_count = 0;
                
                if (parse_insert_data(argc, argv, insert_index + 1, 
                                    fields, values, &field_count) == -1) {
                    fprintf(stderr, "Error: Failed to parse insert data\n");
                    return 1;
                }
                
                if (field_count == 0) {
                    fprintf(stderr, "Error: No valid insert fields provided\n");
                    return 1;
                }
                
                char *instance_json = build_instance_json(fields, values, field_count);
                if (!instance_json) {
                    fprintf(stderr, "Error: Failed to build instance JSON\n");
                    for (int i = 0; i < field_count; i++) {
                        free(fields[i]);
                        free(values[i]);
                    }
                    return 1;
                }
                
                int result = instance_insert(argv[2], argv[3], instance_json);
                
                free(instance_json);
                for (int i = 0; i < field_count; i++) {
                    free(fields[i]);
                    free(values[i]);
                }
                
                return result;
            }
            else {
                fprintf(stderr, "Error: Missing --schema or --insert-one flag\n");
                print_usage();
                return 1;
            }
        }
        else {
            fprintf(stderr, "Error: Invalid create operation\n");
            print_usage();
            return 1;
        }
    }
    else if (strcmp(argv[1], "update") == 0) {
        if (argc < 7 || strcmp(argv[4], "--where") != 0 || 
            strcmp(argv[6], "--set") != 0) {
            fprintf(stderr, "Error: Invalid update syntax\n");
            print_usage();
            return 1;
        }
        
        char *fields[MAX_FIELDS];
        char *values[MAX_FIELDS];
        int field_count = 0;
        
        if (parse_insert_data(argc, argv, 7, fields, values, &field_count) == -1) {
            fprintf(stderr, "Error: Failed to parse update data\n");
            return 1;
        }
        
        if (field_count == 0) {
            fprintf(stderr, "Error: No valid update fields provided\n");
            return 1;
        }
        
        char *update_json = build_instance_json(fields, values, field_count);
        if (!update_json) {
            fprintf(stderr, "Error: Failed to build update JSON\n");
            for (int i = 0; i < field_count; i++) {
                free(fields[i]);
                free(values[i]);
            }
            return 1;
        }
        
        int result = instance_update(argv[2], argv[3], argv[5], update_json);
        
        free(update_json);
        for (int i = 0; i < field_count; i++) {
            free(fields[i]);
            free(values[i]);
        }
        
        return result;
    }
    else if (strcmp(argv[1], "delete") == 0) {
        if (argc < 6 || strcmp(argv[4], "--where") != 0) {
            fprintf(stderr, "Error: Invalid delete syntax\n");
            print_usage();
            return 1;
        }
        
        return instance_delete(argv[2], argv[3], argv[5]);
    }
    else if (strcmp(argv[1], "find") == 0) {
        if (argc < 6 || strcmp(argv[4], "--where") != 0) {
            fprintf(stderr, "Error: Invalid find syntax\n");
            print_usage();
            return 1;
        }
        
        int result_count;
        char **results = instance_find(argv[2], argv[3], argv[5], &result_count);
        if (result_count > 0) {
            for (int i = 0; i < result_count; i++) {
                printf("%s\n", results[i]);
                free(results[i]);
            }
            free(results);
            return 0;
        } else {
            printf("No instances found\n");
            return 1;
        }
    }
    else if (strcmp(argv[1], "schema") == 0) {
        if (argc < 4) {
            fprintf(stderr, "Error: Missing database or collection name\n");
            print_usage();
            return 1;
        }
        
        print_schema(argv[2], argv[3]);
        return 0;
    }
    else if (strcmp(argv[1], "list") == 0) {
        if (argc == 2) {
            int db_count;
            char **dbs = database_list(&db_count);
            if (db_count == 0) {
                printf("No databases found\n");
            } else {
                printf("Databases:\n");
                for (int i = 0; i < db_count; i++) {
                    printf("  %s\n", dbs[i]);
                    free(dbs[i]);
                }
                free(dbs);
            }
            return 0;
        }
        else if (argc == 3) {
            int coll_count;
            char **collections = collection_list(argv[2], &coll_count);
            if (coll_count == 0) {
                printf("No collections found in database '%s'\n", argv[2]);
            } else {
                printf("Collections in database '%s':\n", argv[2]);
                for (int i = 0; i < coll_count; i++) {
                    printf("  %s\n", collections[i]);
                    free(collections[i]);
                }
                free(collections);
            }
            return 0;
        }
        else if (argc == 4) {
            int instance_count;
            char **instances = instance_list(argv[2], argv[3], &instance_count);
            if (instance_count == 0) {
                printf("No instances found in collection '%s'\n", argv[3]);
            } else {
                printf("Instances in collection '%s':\n", argv[3]);
                for (int i = 0; i < instance_count; i++) {
                    printf("  %s\n", instances[i]);
                    free(instances[i]);
                }
                free(instances);
            }
            return 0;
        }
        else {
            fprintf(stderr, "Error: Invalid list operation\n");
            print_usage();
            return 1;
        }
    }
    else {
        fprintf(stderr, "Error: Unknown command '%s'\n", argv[1]);
        print_usage();
        return 1;
    }
    
    return 0;
}
