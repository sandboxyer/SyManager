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

// ==================== CONSTANTS AND CONFIGURATION ====================

#define MAX_NAME_LEN 256
#define MAX_FIELD_LEN 64
#define MAX_FIELDS 32
#define MAX_PATH_LEN 1024
#define MAX_LINE_LEN 4096
#define UUID_SIZE 37
#define SYDB_BASE_DIR "/var/lib/sydb"
#define LOCK_TIMEOUT 30

typedef enum {
    TYPE_STRING,
    TYPE_INT,
    TYPE_FLOAT,
    TYPE_BOOL,
    TYPE_ARRAY,
    TYPE_OBJECT,
    TYPE_NULL
} field_type_t;

// ==================== DATA STRUCTURES ====================

typedef struct {
    char name[MAX_FIELD_LEN];
    field_type_t type;
    bool required;
} field_schema_t;

typedef struct {
    char uuid[UUID_SIZE];
    char *data;
    size_t data_len;
} instance_t;

// ==================== UTILITY FUNCTIONS ====================

void generate_uuid(char *uuid) {
    const char *chars = "0123456789abcdef";
    int segments[] = {8, 4, 4, 4, 12};
    int pos = 0;
    
    srand(time(NULL) + getpid() + rand());
    
    for (int i = 0; i < 5; i++) {
        if (i > 0) uuid[pos++] = '-';
        for (int j = 0; j < segments[i]; j++) {
            uuid[pos++] = chars[rand() % 16];
        }
    }
    uuid[pos] = '\0';
}

int create_directory(const char *path) {
    struct stat st = {0};
    if (stat(path, &st) == -1) {
        if (mkdir(path, 0755) == -1) {
            fprintf(stderr, "Error creating directory %s: %s\n", path, strerror(errno));
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

char* get_sydb_base_dir() {
    static char base_dir[MAX_PATH_LEN];
    const char *env_dir = getenv("SYDB_BASE_DIR");
    if (env_dir) {
        strncpy(base_dir, env_dir, MAX_PATH_LEN - 1);
    } else {
        strncpy(base_dir, SYDB_BASE_DIR, MAX_PATH_LEN - 1);
    }
    return base_dir;
}

// ==================== JSON-LIKE PARSING (Simple) ====================

char* json_get_string(const char *json, const char *key) {
    char search[256];
    snprintf(search, sizeof(search), "\"%s\":\"", key);
    char *start = strstr(json, search);
    if (!start) return NULL;
    
    start += strlen(search);
    char *end = strchr(start, '"');
    if (!end) return NULL;
    
    size_t len = end - start;
    char *result = malloc(len + 1);
    strncpy(result, start, len);
    result[len] = '\0';
    return result;
}

int json_get_int(const char *json, const char *key) {
    char search[256];
    snprintf(search, sizeof(search), "\"%s\":", key);
    char *start = strstr(json, search);
    if (!start) return 0;
    
    start += strlen(search);
    return atoi(start);
}

bool json_has_field(const char *json, const char *key) {
    char search[256];
    snprintf(search, sizeof(search), "\"%s\":", key);
    return strstr(json, search) != NULL;
}

bool json_matches_query(const char *json, const char *query) {
    // Simple query matching: "field:value,field2:value2"
    char query_copy[1024];
    strncpy(query_copy, query, sizeof(query_copy) - 1);
    
    char *token = strtok(query_copy, ",");
    while (token) {
        char *colon = strchr(token, ':');
        if (!colon) {
            token = strtok(NULL, ",");
            continue;
        }
        
        *colon = '\0';
        char *field = token;
        char *value = colon + 1;
        
        // Remove quotes if present
        if (value[0] == '"' && value[strlen(value)-1] == '"') {
            value[strlen(value)-1] = '\0';
            value++;
        }
        
        char *actual_value = json_get_string(json, field);
        if (!actual_value) {
            // Try as int
            int actual_int = json_get_int(json, field);
            int query_int = atoi(value);
            if (actual_int != query_int) {
                return false;
            }
        } else {
            if (strcmp(actual_value, value) != 0) {
                free(actual_value);
                return false;
            }
            free(actual_value);
        }
        
        token = strtok(NULL, ",");
    }
    
    return true;
}

// ==================== SCHEMA PARSING AND VALIDATION ====================

field_type_t parse_field_type(const char *type_str) {
    if (strcmp(type_str, "string") == 0) return TYPE_STRING;
    if (strcmp(type_str, "int") == 0) return TYPE_INT;
    if (strcmp(type_str, "float") == 0) return TYPE_FLOAT;
    if (strcmp(type_str, "bool") == 0) return TYPE_BOOL;
    if (strcmp(type_str, "array") == 0) return TYPE_ARRAY;
    if (strcmp(type_str, "object") == 0) return TYPE_OBJECT;
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

int parse_schema_fields(int argc, char *argv[], int start_idx, field_schema_t *fields, int *field_count) {
    *field_count = 0;
    
    for (int i = start_idx; i < argc && *field_count < MAX_FIELDS; i++) {
        char *field_spec = argv[i];
        if (strncmp(field_spec, "--", 2) != 0) continue;
        
        field_spec += 2;
        
        char field_name[MAX_FIELD_LEN];
        char field_type[32];
        bool required = false;
        
        char *dash1 = strchr(field_spec, '-');
        if (!dash1) continue;
        
        *dash1 = '\0';
        strncpy(field_name, field_spec, MAX_FIELD_LEN - 1);
        
        char *dash2 = strchr(dash1 + 1, '-');
        if (dash2) {
            *dash2 = '\0';
            strncpy(field_type, dash1 + 1, sizeof(field_type) - 1);
            required = (strcmp(dash2 + 1, "req") == 0);
        } else {
            strncpy(field_type, dash1 + 1, sizeof(field_type) - 1);
            required = false;
        }
        
        field_type_t type = parse_field_type(field_type);
        if (type == TYPE_NULL) {
            fprintf(stderr, "Unknown field type: %s\n", field_type);
            return -1;
        }
        
        strncpy(fields[*field_count].name, field_name, MAX_FIELD_LEN - 1);
        fields[*field_count].type = type;
        fields[*field_count].required = required;
        (*field_count)++;
    }
    
    return 0;
}

int load_schema(const char *db_name, const char *collection_name, field_schema_t *fields, int *field_count) {
    char schema_file[MAX_PATH_LEN];
    snprintf(schema_file, MAX_PATH_LEN, "%s/%s/%s/schema.txt", 
             get_sydb_base_dir(), db_name, collection_name);
    
    FILE *fp = fopen(schema_file, "r");
    if (!fp) {
        fprintf(stderr, "Error: Cannot load schema for collection '%s'\n", collection_name);
        return -1;
    }
    
    *field_count = 0;
    char line[256];
    
    while (fgets(line, sizeof(line), fp) && *field_count < MAX_FIELDS) {
        line[strcspn(line, "\n")] = 0;
        
        char *colon1 = strchr(line, ':');
        char *colon2 = colon1 ? strchr(colon1 + 1, ':') : NULL;
        
        if (!colon1 || !colon2) continue;
        
        *colon1 = '\0';
        *colon2 = '\0';
        
        char *field_name = line;
        char *type_str = colon1 + 1;
        char *required_str = colon2 + 1;
        
        strncpy(fields[*field_count].name, field_name, MAX_FIELD_LEN - 1);
        fields[*field_count].type = parse_field_type(type_str);
        fields[*field_count].required = (strcmp(required_str, "required") == 0);
        (*field_count)++;
    }
    
    fclose(fp);
    return 0;
}

int validate_instance_against_schema(const char *instance_json, field_schema_t *fields, int field_count) {
    for (int i = 0; i < field_count; i++) {
        if (fields[i].required && !json_has_field(instance_json, fields[i].name)) {
            fprintf(stderr, "Validation error: Required field '%s' is missing\n", fields[i].name);
            return -1;
        }
        
        if (json_has_field(instance_json, fields[i].name)) {
            // Basic type validation - in a real implementation you'd want more sophisticated checking
            char *value = json_get_string(instance_json, fields[i].name);
            if (value) {
                // For now, we just check if it exists. More sophisticated type checking would go here.
                free(value);
            }
        }
    }
    return 0;
}

void print_schema(const char *db_name, const char *collection_name) {
    field_schema_t fields[MAX_FIELDS];
    int field_count = 0;
    
    if (load_schema(db_name, collection_name, fields, &field_count) == -1) {
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

int database_create(const char *db_name) {
    char base_dir[MAX_PATH_LEN];
    strncpy(base_dir, get_sydb_base_dir(), MAX_PATH_LEN - 1);
    
    if (create_directory(base_dir) == -1) {
        return -1;
    }
    
    char db_path[MAX_PATH_LEN];
    snprintf(db_path, MAX_PATH_LEN, "%s/%s", base_dir, db_name);
    
    if (create_directory(db_path) == -1) {
        return -1;
    }
    
    printf("Database '%s' created successfully at %s\n", db_name, db_path);
    return 0;
}

int database_exists(const char *db_name) {
    char db_path[MAX_PATH_LEN];
    snprintf(db_path, MAX_PATH_LEN, "%s/%s", get_sydb_base_dir(), db_name);
    
    struct stat st = {0};
    return (stat(db_path, &st) == 0 && S_ISDIR(st.st_mode));
}

char** database_list(int *count) {
    char base_dir[MAX_PATH_LEN];
    strncpy(base_dir, get_sydb_base_dir(), MAX_PATH_LEN - 1);
    
    DIR *dir = opendir(base_dir);
    if (!dir) {
        *count = 0;
        return NULL;
    }
    
    struct dirent *entry;
    int db_count = 0;
    while ((entry = readdir(dir)) != NULL) {
        if (entry->d_type == DT_DIR && strcmp(entry->d_name, ".") != 0 && 
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
    
    char **databases = malloc(db_count * sizeof(char*));
    int index = 0;
    while ((entry = readdir(dir)) != NULL && index < db_count) {
        if (entry->d_type == DT_DIR && strcmp(entry->d_name, ".") != 0 && 
            strcmp(entry->d_name, "..") != 0) {
            databases[index] = strdup(entry->d_name);
            index++;
        }
    }
    closedir(dir);
    
    *count = db_count;
    return databases;
}

// ==================== COLLECTION OPERATIONS ====================

int collection_create(const char *db_name, const char *collection_name, 
                     field_schema_t *fields, int field_count) {
    if (!database_exists(db_name)) {
        fprintf(stderr, "Database '%s' does not exist\n", db_name);
        return -1;
    }
    
    char db_path[MAX_PATH_LEN];
    snprintf(db_path, MAX_PATH_LEN, "%s/%s", get_sydb_base_dir(), db_name);
    
    char collection_path[MAX_PATH_LEN];
    snprintf(collection_path, MAX_PATH_LEN, "%s/%s", db_path, collection_name);
    
    if (create_directory(collection_path) == -1) {
        return -1;
    }
    
    // Create schema file
    char schema_file[MAX_PATH_LEN];
    snprintf(schema_file, MAX_PATH_LEN, "%s/schema.txt", collection_path);
    
    char lock_file[MAX_PATH_LEN];
    snprintf(lock_file, MAX_PATH_LEN, "%s/.schema.lock", collection_path);
    int lock_fd = acquire_lock(lock_file);
    if (lock_fd == -1) {
        return -1;
    }
    
    FILE *fp = fopen(schema_file, "w");
    if (!fp) {
        fprintf(stderr, "Error creating schema file: %s\n", strerror(errno));
        release_lock(lock_fd, lock_file);
        return -1;
    }
    
    for (int i = 0; i < field_count; i++) {
        fprintf(fp, "%s:%s:%s\n", 
                fields[i].name, 
                field_type_to_string(fields[i].type),
                fields[i].required ? "required" : "optional");
    }
    
    fclose(fp);
    release_lock(lock_fd, lock_file);
    
    // Create data file
    char data_file[MAX_PATH_LEN];
    snprintf(data_file, MAX_PATH_LEN, "%s/data.txt", collection_path);
    FILE *data_fp = fopen(data_file, "w");
    if (data_fp) fclose(data_fp);
    
    printf("Collection '%s' created successfully in database '%s'\n", collection_name, db_name);
    return 0;
}

int collection_exists(const char *db_name, const char *collection_name) {
    char collection_path[MAX_PATH_LEN];
    snprintf(collection_path, MAX_PATH_LEN, "%s/%s/%s", 
             get_sydb_base_dir(), db_name, collection_name);
    
    struct stat st = {0};
    return (stat(collection_path, &st) == 0 && S_ISDIR(st.st_mode));
}

char** collection_list(const char *db_name, int *count) {
    char db_path[MAX_PATH_LEN];
    snprintf(db_path, MAX_PATH_LEN, "%s/%s", get_sydb_base_dir(), db_name);
    
    DIR *dir = opendir(db_path);
    if (!dir) {
        *count = 0;
        return NULL;
    }
    
    struct dirent *entry;
    int coll_count = 0;
    while ((entry = readdir(dir)) != NULL) {
        if (entry->d_type == DT_DIR && strcmp(entry->d_name, ".") != 0 && 
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
    int index = 0;
    while ((entry = readdir(dir)) != NULL && index < coll_count) {
        if (entry->d_type == DT_DIR && strcmp(entry->d_name, ".") != 0 && 
            strcmp(entry->d_name, "..") != 0) {
            collections[index] = strdup(entry->d_name);
            index++;
        }
    }
    closedir(dir);
    
    *count = coll_count;
    return collections;
}

// ==================== INSTANCE OPERATIONS ====================

char* build_instance_json(char **fields, char **values, int count) {
    char *json = malloc(MAX_LINE_LEN);
    strcpy(json, "{");
    
    for (int i = 0; i < count; i++) {
        if (i > 0) strcat(json, ",");
        
        // Check if value looks like JSON object/array
        if ((values[i][0] == '[' && values[i][strlen(values[i])-1] == ']') ||
            (values[i][0] == '{' && values[i][strlen(values[i])-1] == '}')) {
            snprintf(json + strlen(json), MAX_LINE_LEN - strlen(json), 
                    "\"%s\":%s", fields[i], values[i]);
        } else {
            // Check if it's a number
            char *endptr;
            strtol(values[i], &endptr, 10);
            if (*endptr == '\0') {
                // It's a number
                snprintf(json + strlen(json), MAX_LINE_LEN - strlen(json), 
                        "\"%s\":%s", fields[i], values[i]);
            } else {
                // It's a string
                snprintf(json + strlen(json), MAX_LINE_LEN - strlen(json), 
                        "\"%s\":\"%s\"", fields[i], values[i]);
            }
        }
    }
    
    strcat(json, "}");
    return json;
}

int instance_insert(const char *db_name, const char *collection_name, char *instance_json) {
    if (!database_exists(db_name) || !collection_exists(db_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        return -1;
    }
    
    // Load schema and validate
    field_schema_t fields[MAX_FIELDS];
    int field_count = 0;
    if (load_schema(db_name, collection_name, fields, &field_count) == -1) {
        return -1;
    }
    
    if (validate_instance_against_schema(instance_json, fields, field_count) == -1) {
        fprintf(stderr, "Instance validation failed against schema\n");
        return -1;
    }
    
    char collection_path[MAX_PATH_LEN];
    snprintf(collection_path, MAX_PATH_LEN, "%s/%s/%s", 
             get_sydb_base_dir(), db_name, collection_name);
    
    char lock_file[MAX_PATH_LEN];
    snprintf(lock_file, MAX_PATH_LEN, "%s/.data.lock", collection_path);
    int lock_fd = acquire_lock(lock_file);
    if (lock_fd == -1) {
        return -1;
    }
    
    // Generate UUID and add to instance
    char uuid[UUID_SIZE];
    generate_uuid(uuid);
    
    char full_json[MAX_LINE_LEN];
    snprintf(full_json, sizeof(full_json), "{\"_id\":\"%s\",\"_created_at\":%ld,%s", 
             uuid, time(NULL), instance_json + 1);
    
    char data_file[MAX_PATH_LEN];
    snprintf(data_file, MAX_PATH_LEN, "%s/data.txt", collection_path);
    
    FILE *fp = fopen(data_file, "a");
    if (!fp) {
        fprintf(stderr, "Error opening data file: %s\n", strerror(errno));
        release_lock(lock_fd, lock_file);
        return -1;
    }
    
    fprintf(fp, "%s\n", full_json);
    fflush(fp);
    fsync(fileno(fp));
    fclose(fp);
    
    release_lock(lock_fd, lock_file);
    
    printf("Instance inserted successfully with ID: %s\n", uuid);
    return 0;
}

int instance_update(const char *db_name, const char *collection_name, const char *query, char *update_json) {
    if (!database_exists(db_name) || !collection_exists(db_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        return -1;
    }
    
    // Load schema and validate update against schema
    field_schema_t fields[MAX_FIELDS];
    int field_count = 0;
    if (load_schema(db_name, collection_name, fields, &field_count) == 0) {
        // Create a temporary instance JSON with the update data to validate
        char temp_instance[MAX_LINE_LEN];
        snprintf(temp_instance, sizeof(temp_instance), "{%s}", update_json + 1);
        if (validate_instance_against_schema(temp_instance, fields, field_count) == -1) {
            fprintf(stderr, "Update validation failed against schema\n");
            return -1;
        }
    }
    
    char collection_path[MAX_PATH_LEN];
    snprintf(collection_path, MAX_PATH_LEN, "%s/%s/%s", 
             get_sydb_base_dir(), db_name, collection_name);
    
    char lock_file[MAX_PATH_LEN];
    snprintf(lock_file, MAX_PATH_LEN, "%s/.data.lock", collection_path);
    int lock_fd = acquire_lock(lock_file);
    if (lock_fd == -1) {
        return -1;
    }
    
    char data_file[MAX_PATH_LEN];
    snprintf(data_file, MAX_PATH_LEN, "%s/data.txt", collection_path);
    char temp_file[MAX_PATH_LEN];
    snprintf(temp_file, MAX_PATH_LEN, "%s/data.tmp", collection_path);
    
    FILE *fp = fopen(data_file, "r");
    FILE *tmp_fp = fopen(temp_file, "w");
    if (!fp || !tmp_fp) {
        fprintf(stderr, "Error opening files: %s\n", strerror(errno));
        if (fp) fclose(fp);
        if (tmp_fp) fclose(tmp_fp);
        release_lock(lock_fd, lock_file);
        return -1;
    }
    
    char line[MAX_LINE_LEN];
    int updated = 0;
    
    while (fgets(line, sizeof(line), fp)) {
        line[strcspn(line, "\n")] = 0;
        
        if (json_matches_query(line, query)) {
            // Merge update with existing data
            char *update_data = update_json + 1;
            update_data[strlen(update_data)-1] = '\0';
            
            char *insert_point = strchr(line, ',');
            if (insert_point) {
                insert_point++;
                
                char new_line[MAX_LINE_LEN];
                strncpy(new_line, line, insert_point - line);
                new_line[insert_point - line] = '\0';
                strcat(new_line, update_data);
                strcat(new_line, "}");
                
                fprintf(tmp_fp, "%s\n", new_line);
            } else {
                fprintf(tmp_fp, "%s\n", line);
            }
            updated++;
        } else {
            fprintf(tmp_fp, "%s\n", line);
        }
    }
    
    fclose(fp);
    fclose(tmp_fp);
    
    if (updated > 0) {
        rename(temp_file, data_file);
        printf("Updated %d instance(s)\n", updated);
    } else {
        remove(temp_file);
        printf("No instances found matching query\n");
    }
    
    release_lock(lock_fd, lock_file);
    return updated > 0 ? 0 : -1;
}

int instance_delete(const char *db_name, const char *collection_name, const char *query) {
    if (!database_exists(db_name) || !collection_exists(db_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        return -1;
    }
    
    char collection_path[MAX_PATH_LEN];
    snprintf(collection_path, MAX_PATH_LEN, "%s/%s/%s", 
             get_sydb_base_dir(), db_name, collection_name);
    
    char lock_file[MAX_PATH_LEN];
    snprintf(lock_file, MAX_PATH_LEN, "%s/.data.lock", collection_path);
    int lock_fd = acquire_lock(lock_file);
    if (lock_fd == -1) {
        return -1;
    }
    
    char data_file[MAX_PATH_LEN];
    snprintf(data_file, MAX_PATH_LEN, "%s/data.txt", collection_path);
    char temp_file[MAX_PATH_LEN];
    snprintf(temp_file, MAX_PATH_LEN, "%s/data.tmp", collection_path);
    
    FILE *fp = fopen(data_file, "r");
    FILE *tmp_fp = fopen(temp_file, "w");
    if (!fp || !tmp_fp) {
        fprintf(stderr, "Error opening files: %s\n", strerror(errno));
        if (fp) fclose(fp);
        if (tmp_fp) fclose(tmp_fp);
        release_lock(lock_fd, lock_file);
        return -1;
    }
    
    char line[MAX_LINE_LEN];
    int deleted = 0;
    
    while (fgets(line, sizeof(line), fp)) {
        line[strcspn(line, "\n")] = 0;
        
        if (!json_matches_query(line, query)) {
            fprintf(tmp_fp, "%s\n", line);
        } else {
            deleted++;
        }
    }
    
    fclose(fp);
    fclose(tmp_fp);
    
    if (deleted > 0) {
        rename(temp_file, data_file);
        printf("Deleted %d instance(s)\n", deleted);
    } else {
        remove(temp_file);
        printf("No instances found matching query\n");
    }
    
    release_lock(lock_fd, lock_file);
    return deleted > 0 ? 0 : -1;
}

char* instance_find_one(const char *db_name, const char *collection_name, const char *query) {
    if (!database_exists(db_name) || !collection_exists(db_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        return NULL;
    }
    
    char data_file[MAX_PATH_LEN];
    snprintf(data_file, MAX_PATH_LEN, "%s/%s/%s/data.txt", 
             get_sydb_base_dir(), db_name, collection_name);
    
    FILE *fp = fopen(data_file, "r");
    if (!fp) {
        return NULL;
    }
    
    char line[MAX_LINE_LEN];
    char *result = NULL;
    
    while (fgets(line, sizeof(line), fp)) {
        line[strcspn(line, "\n")] = 0;
        
        if (json_matches_query(line, query)) {
            result = strdup(line);
            break;
        }
    }
    
    fclose(fp);
    return result;
}

char** instance_list(const char *db_name, const char *collection_name, int *count) {
    char data_file[MAX_PATH_LEN];
    snprintf(data_file, MAX_PATH_LEN, "%s/%s/%s/data.txt", 
             get_sydb_base_dir(), db_name, collection_name);
    
    FILE *fp = fopen(data_file, "r");
    if (!fp) {
        *count = 0;
        return NULL;
    }
    
    char line[MAX_LINE_LEN];
    int instance_count = 0;
    while (fgets(line, sizeof(line), fp)) {
        instance_count++;
    }
    rewind(fp);
    
    if (instance_count == 0) {
        fclose(fp);
        *count = 0;
        return NULL;
    }
    
    char **instances = malloc(instance_count * sizeof(char*));
    int index = 0;
    while (fgets(line, sizeof(line), fp) && index < instance_count) {
        line[strcspn(line, "\n")] = 0;
        char *id = json_get_string(line, "_id");
        if (id) {
            instances[index] = id;
            index++;
        }
    }
    fclose(fp);
    
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
    printf("Query format: field:value,field2:value2\n");
}

int parse_insert_data(int argc, char *argv[], int start_idx, char **fields, char **values, int *count) {
    *count = 0;
    
    for (int i = start_idx; i < argc && *count < MAX_FIELDS; i++) {
        char *field_spec = argv[i];
        if (strncmp(field_spec, "--", 2) != 0) continue;
        
        field_spec += 2;
        
        char *value_start = strchr(field_spec, '-');
        if (!value_start) continue;
        
        *value_start = '\0';
        char *field_value = value_start + 1;
        
        if (field_value[0] == '"' && field_value[strlen(field_value)-1] == '"') {
            field_value[strlen(field_value)-1] = '\0';
            field_value++;
        }
        
        fields[*count] = strdup(field_spec);
        values[*count] = strdup(field_value);
        (*count)++;
    }
    
    return 0;
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        print_usage();
        return 1;
    }
    
    create_directory(get_sydb_base_dir());
    
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
                if (parse_schema_fields(argc, argv, schema_index + 1, fields, &field_count) == -1) {
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
                
                if (parse_insert_data(argc, argv, insert_index + 1, fields, values, &field_count) == -1) {
                    return 1;
                }
                
                char *instance_json = build_instance_json(fields, values, field_count);
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
        if (argc < 7 || strcmp(argv[4], "--where") != 0 || strcmp(argv[6], "--set") != 0) {
            fprintf(stderr, "Error: Invalid update syntax\n");
            print_usage();
            return 1;
        }
        
        char *fields[MAX_FIELDS];
        char *values[MAX_FIELDS];
        int field_count = 0;
        
        if (parse_insert_data(argc, argv, 7, fields, values, &field_count) == -1) {
            return 1;
        }
        
        char *update_json = build_instance_json(fields, values, field_count);
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
        
        char *result = instance_find_one(argv[2], argv[3], argv[5]);
        if (result) {
            printf("%s\n", result);
            free(result);
            return 0;
        } else {
            printf("No instance found\n");
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
            int count;
            char **databases = database_list(&count);
            if (count == 0) {
                printf("No databases found\n");
            } else {
                printf("Databases:\n");
                for (int i = 0; i < count; i++) {
                    printf("  %s\n", databases[i]);
                    free(databases[i]);
                }
                free(databases);
            }
            return 0;
        }
        else if (argc == 3) {
            int count;
            char **collections = collection_list(argv[2], &count);
            if (count == 0) {
                printf("No collections found in database '%s'\n", argv[2]);
            } else {
                printf("Collections in database '%s':\n", argv[2]);
                for (int i = 0; i < count; i++) {
                    printf("  %s\n", collections[i]);
                    free(collections[i]);
                }
                free(collections);
            }
            return 0;
        }
        else if (argc == 4) {
            int count;
            char **instances = instance_list(argv[2], argv[3], &count);
            if (count == 0) {
                printf("No instances found in collection '%s'\n", argv[3]);
            } else {
                printf("Instances in collection '%s':\n", argv[3]);
                for (int i = 0; i < count; i++) {
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
