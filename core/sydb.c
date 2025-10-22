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
    char name[MAX_FIELD_LENGTH];
    field_type_t type;
    bool required;
} field_schema_t;

typedef struct {
    char uuid[UUID_SIZE];
    char *data;
    size_t data_length;
} instance_t;

// ==================== UTILITY FUNCTIONS ====================

void generate_uuid(char *uuid) {
    const char *characters = "0123456789abcdef";
    int segments[] = {8, 4, 4, 4, 12};
    int position = 0;
    
    srand(time(NULL) + getpid() + rand());
    
    for (int segment_index = 0; segment_index < 5; segment_index++) {
        if (segment_index > 0) uuid[position++] = '-';
        for (int character_index = 0; character_index < segments[segment_index]; character_index++) {
            uuid[position++] = characters[rand() % 16];
        }
    }
    uuid[position] = '\0';
}

int create_directory(const char *path) {
    struct stat status_info;
    if (stat(path, &status_info) == -1) {
        if (mkdir(path, 0755) == -1) {
            fprintf(stderr, "Error creating directory %s: %s\n", path, strerror(errno));
            return -1;
        }
    }
    return 0;
}

int acquire_lock(const char *lock_file) {
    int file_descriptor = open(lock_file, O_CREAT | O_RDWR, 0644);
    if (file_descriptor == -1) {
        fprintf(stderr, "Error creating lock file %s: %s\n", lock_file, strerror(errno));
        return -1;
    }
    
    struct timespec timeout;
    clock_gettime(CLOCK_REALTIME, &timeout);
    timeout.tv_sec += LOCK_TIMEOUT;
    
    if (flock(file_descriptor, LOCK_EX | LOCK_NB) == -1) {
        if (errno == EWOULDBLOCK) {
            fprintf(stderr, "Timeout: Could not acquire lock on %s after %d seconds\n", 
                    lock_file, LOCK_TIMEOUT);
            close(file_descriptor);
            return -1;
        }
    }
    
    return file_descriptor;
}

void release_lock(int file_descriptor, const char *lock_file) {
    if (file_descriptor != -1) {
        flock(file_descriptor, LOCK_UN);
        close(file_descriptor);
    }
}

char* get_sydb_base_directory() {
    static char base_directory[MAX_PATH_LENGTH];
    const char *environment_directory = getenv("SYDB_BASE_DIR");
    if (environment_directory) {
        strncpy(base_directory, environment_directory, MAX_PATH_LENGTH - 1);
        base_directory[MAX_PATH_LENGTH - 1] = '\0';
    } else {
        strncpy(base_directory, SYDB_BASE_DIRECTORY, MAX_PATH_LENGTH - 1);
        base_directory[MAX_PATH_LENGTH - 1] = '\0';
    }
    return base_directory;
}

// ==================== JSON-LIKE PARSING (Simple) ====================

char* json_get_string(const char *json, const char *key) {
    char search_pattern[256];
    snprintf(search_pattern, sizeof(search_pattern), "\"%s\":\"", key);
    char *start_position = strstr(json, search_pattern);
    if (!start_position) return NULL;
    
    start_position += strlen(search_pattern);
    char *end_position = strchr(start_position, '"');
    if (!end_position) return NULL;
    
    size_t length = end_position - start_position;
    char *result = malloc(length + 1);
    if (!result) return NULL;
    
    strncpy(result, start_position, length);
    result[length] = '\0';
    return result;
}

int json_get_int(const char *json, const char *key) {
    char search_pattern[256];
    snprintf(search_pattern, sizeof(search_pattern), "\"%s\":", key);
    char *start_position = strstr(json, search_pattern);
    if (!start_position) return 0;
    
    start_position += strlen(search_pattern);
    return atoi(start_position);
}

bool json_has_field(const char *json, const char *key) {
    char search_pattern[256];
    snprintf(search_pattern, sizeof(search_pattern), "\"%s\":", key);
    return strstr(json, search_pattern) != NULL;
}

bool json_matches_query(const char *json, const char *query) {
    if (!query || !json) return false;
    
    char query_copy[1024];
    strncpy(query_copy, query, sizeof(query_copy) - 1);
    query_copy[sizeof(query_copy) - 1] = '\0';
    
    char *token = strtok(query_copy, ",");
    while (token) {
        // Skip any leading spaces
        while (*token == ' ') token++;
        
        char *colon_position = strchr(token, ':');
        if (!colon_position) {
            token = strtok(NULL, ",");
            continue;
        }
        
        *colon_position = '\0';
        char *field_name = token;
        char *expected_value = colon_position + 1;
        
        // Remove surrounding quotes if present
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
            // Try as integer
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

int parse_schema_fields(int argument_count, char *argument_values[], int start_index, 
                       field_schema_t *fields, int *field_count) {
    *field_count = 0;
    
    for (int argument_index = start_index; 
         argument_index < argument_count && *field_count < MAX_FIELDS; 
         argument_index++) {
        char *field_specification = argument_values[argument_index];
        if (strncmp(field_specification, "--", 2) != 0) continue;
        
        field_specification += 2;
        
        char field_name[MAX_FIELD_LENGTH];
        char field_type_string[32];
        bool required = false;
        
        char *first_dash = strchr(field_specification, '-');
        if (!first_dash) continue;
        
        *first_dash = '\0';
        strncpy(field_name, field_specification, MAX_FIELD_LENGTH - 1);
        field_name[MAX_FIELD_LENGTH - 1] = '\0';
        
        char *second_dash = strchr(first_dash + 1, '-');
        if (second_dash) {
            *second_dash = '\0';
            strncpy(field_type_string, first_dash + 1, sizeof(field_type_string) - 1);
            field_type_string[sizeof(field_type_string) - 1] = '\0';
            required = (strcmp(second_dash + 1, "req") == 0);
        } else {
            strncpy(field_type_string, first_dash + 1, sizeof(field_type_string) - 1);
            field_type_string[sizeof(field_type_string) - 1] = '\0';
            required = false;
        }
        
        field_type_t type = parse_field_type(field_type_string);
        if (type == TYPE_NULL) {
            fprintf(stderr, "Error: Unknown field type '%s' for field '%s'\n", 
                    field_type_string, field_name);
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
    char schema_file_path[MAX_PATH_LENGTH];
    snprintf(schema_file_path, MAX_PATH_LENGTH, "%s/%s/%s/schema.txt", 
             get_sydb_base_directory(), database_name, collection_name);
    
    FILE *file_pointer = fopen(schema_file_path, "r");
    if (!file_pointer) {
        fprintf(stderr, "Error: Cannot load schema for collection '%s'\n", collection_name);
        return -1;
    }
    
    *field_count = 0;
    char line_buffer[256];
    
    while (fgets(line_buffer, sizeof(line_buffer), file_pointer) && *field_count < MAX_FIELDS) {
        line_buffer[strcspn(line_buffer, "\n")] = '\0';
        
        char *first_colon = strchr(line_buffer, ':');
        char *second_colon = first_colon ? strchr(first_colon + 1, ':') : NULL;
        
        if (!first_colon || !second_colon) continue;
        
        *first_colon = '\0';
        *second_colon = '\0';
        
        char *field_name = line_buffer;
        char *type_string = first_colon + 1;
        char *required_string = second_colon + 1;
        
        strncpy(fields[*field_count].name, field_name, MAX_FIELD_LENGTH - 1);
        fields[*field_count].name[MAX_FIELD_LENGTH - 1] = '\0';
        fields[*field_count].type = parse_field_type(type_string);
        fields[*field_count].required = (strcmp(required_string, "required") == 0);
        (*field_count)++;
    }
    
    fclose(file_pointer);
    return 0;
}

bool validate_field_value_against_type(const char *field_name, const char *value, field_type_t type) {
    if (!value || strlen(value) == 0) {
        return true; // Empty values are allowed for optional fields
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
            return true; // No strict validation for these types yet
    }
}

int validate_instance_against_schema(const char *instance_json, 
                                    field_schema_t *fields, int field_count) {
    for (int field_index = 0; field_index < field_count; field_index++) {
        if (fields[field_index].required && !json_has_field(instance_json, fields[field_index].name)) {
            fprintf(stderr, "Validation error: Required field '%s' is missing\n", 
                    fields[field_index].name);
            return -1;
        }
        
        if (json_has_field(instance_json, fields[field_index].name)) {
            char *value = json_get_string(instance_json, fields[field_index].name);
            if (value) {
                if (!validate_field_value_against_type(fields[field_index].name, value, fields[field_index].type)) {
                    free(value);
                    return -1;
                }
                free(value);
            } else {
                // For numeric fields that are not stored as strings
                int int_value = json_get_int(instance_json, fields[field_index].name);
                if (fields[field_index].type == TYPE_INT) {
                    // This is already validated by the JSON parsing
                }
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
    
    for (int field_index = 0; field_index < field_count; field_index++) {
        printf("%-20s %-10s %-10s\n", 
               fields[field_index].name, 
               field_type_to_string(fields[field_index].type),
               fields[field_index].required ? "Yes" : "No");
    }
}

// ==================== DATABASE OPERATIONS ====================

int database_create(const char *database_name) {
    char base_directory[MAX_PATH_LENGTH];
    strncpy(base_directory, get_sydb_base_directory(), MAX_PATH_LENGTH - 1);
    base_directory[MAX_PATH_LENGTH - 1] = '\0';
    
    if (create_directory(base_directory) == -1) {
        return -1;
    }
    
    char database_path[MAX_PATH_LENGTH];
    snprintf(database_path, MAX_PATH_LENGTH, "%s/%s", base_directory, database_name);
    
    if (create_directory(database_path) == -1) {
        return -1;
    }
    
    printf("Database '%s' created successfully at %s\n", database_name, database_path);
    return 0;
}

int database_exists(const char *database_name) {
    char database_path[MAX_PATH_LENGTH];
    snprintf(database_path, MAX_PATH_LENGTH, "%s/%s", 
             get_sydb_base_directory(), database_name);
    
    struct stat status_info;
    return (stat(database_path, &status_info) == 0 && S_ISDIR(status_info.st_mode));
}

char** database_list(int *count) {
    char base_directory[MAX_PATH_LENGTH];
    strncpy(base_directory, get_sydb_base_directory(), MAX_PATH_LENGTH - 1);
    base_directory[MAX_PATH_LENGTH - 1] = '\0';
    
    DIR *directory_pointer = opendir(base_directory);
    if (!directory_pointer) {
        *count = 0;
        return NULL;
    }
    
    struct dirent *directory_entry;
    int database_count = 0;
    while ((directory_entry = readdir(directory_pointer)) != NULL) {
        if (directory_entry->d_type == DT_DIR && 
            strcmp(directory_entry->d_name, ".") != 0 && 
            strcmp(directory_entry->d_name, "..") != 0) {
            database_count++;
        }
    }
    rewinddir(directory_pointer);
    
    if (database_count == 0) {
        closedir(directory_pointer);
        *count = 0;
        return NULL;
    }
    
    char **databases = malloc(database_count * sizeof(char*));
    if (!databases) {
        closedir(directory_pointer);
        *count = 0;
        return NULL;
    }
    
    int current_index = 0;
    while ((directory_entry = readdir(directory_pointer)) != NULL && current_index < database_count) {
        if (directory_entry->d_type == DT_DIR && 
            strcmp(directory_entry->d_name, ".") != 0 && 
            strcmp(directory_entry->d_name, "..") != 0) {
            databases[current_index] = strdup(directory_entry->d_name);
            if (!databases[current_index]) {
                // Cleanup on allocation failure
                for (int i = 0; i < current_index; i++) {
                    free(databases[i]);
                }
                free(databases);
                closedir(directory_pointer);
                *count = 0;
                return NULL;
            }
            current_index++;
        }
    }
    closedir(directory_pointer);
    
    *count = database_count;
    return databases;
}

// ==================== COLLECTION OPERATIONS ====================

int collection_create(const char *database_name, const char *collection_name, 
                     field_schema_t *fields, int field_count) {
    if (!database_exists(database_name)) {
        fprintf(stderr, "Database '%s' does not exist\n", database_name);
        return -1;
    }
    
    char database_path[MAX_PATH_LENGTH];
    snprintf(database_path, MAX_PATH_LENGTH, "%s/%s", 
             get_sydb_base_directory(), database_name);
    
    char collection_path[MAX_PATH_LENGTH];
    snprintf(collection_path, MAX_PATH_LENGTH, "%s/%s", database_path, collection_name);
    
    if (create_directory(collection_path) == -1) {
        return -1;
    }
    
    // Create schema file
    char schema_file_path[MAX_PATH_LENGTH];
    snprintf(schema_file_path, MAX_PATH_LENGTH, "%s/schema.txt", collection_path);
    
    char lock_file_path[MAX_PATH_LENGTH];
    snprintf(lock_file_path, MAX_PATH_LENGTH, "%s/.schema.lock", collection_path);
    int lock_file_descriptor = acquire_lock(lock_file_path);
    if (lock_file_descriptor == -1) {
        return -1;
    }
    
    FILE *file_pointer = fopen(schema_file_path, "w");
    if (!file_pointer) {
        fprintf(stderr, "Error creating schema file: %s\n", strerror(errno));
        release_lock(lock_file_descriptor, lock_file_path);
        return -1;
    }
    
    for (int field_index = 0; field_index < field_count; field_index++) {
        fprintf(file_pointer, "%s:%s:%s\n", 
                fields[field_index].name, 
                field_type_to_string(fields[field_index].type),
                fields[field_index].required ? "required" : "optional");
    }
    
    fclose(file_pointer);
    release_lock(lock_file_descriptor, lock_file_path);
    
    // Create data file
    char data_file_path[MAX_PATH_LENGTH];
    snprintf(data_file_path, MAX_PATH_LENGTH, "%s/data.txt", collection_path);
    FILE *data_file_pointer = fopen(data_file_path, "w");
    if (data_file_pointer) fclose(data_file_pointer);
    
    printf("Collection '%s' created successfully in database '%s'\n", 
           collection_name, database_name);
    return 0;
}

int collection_exists(const char *database_name, const char *collection_name) {
    char collection_path[MAX_PATH_LENGTH];
    snprintf(collection_path, MAX_PATH_LENGTH, "%s/%s/%s", 
             get_sydb_base_directory(), database_name, collection_name);
    
    struct stat status_info;
    return (stat(collection_path, &status_info) == 0 && S_ISDIR(status_info.st_mode));
}

char** collection_list(const char *database_name, int *count) {
    char database_path[MAX_PATH_LENGTH];
    snprintf(database_path, MAX_PATH_LENGTH, "%s/%s", 
             get_sydb_base_directory(), database_name);
    
    DIR *directory_pointer = opendir(database_path);
    if (!directory_pointer) {
        *count = 0;
        return NULL;
    }
    
    struct dirent *directory_entry;
    int collection_count = 0;
    while ((directory_entry = readdir(directory_pointer)) != NULL) {
        if (directory_entry->d_type == DT_DIR && 
            strcmp(directory_entry->d_name, ".") != 0 && 
            strcmp(directory_entry->d_name, "..") != 0) {
            collection_count++;
        }
    }
    rewinddir(directory_pointer);
    
    if (collection_count == 0) {
        closedir(directory_pointer);
        *count = 0;
        return NULL;
    }
    
    char **collections = malloc(collection_count * sizeof(char*));
    if (!collections) {
        closedir(directory_pointer);
        *count = 0;
        return NULL;
    }
    
    int current_index = 0;
    while ((directory_entry = readdir(directory_pointer)) != NULL && current_index < collection_count) {
        if (directory_entry->d_type == DT_DIR && 
            strcmp(directory_entry->d_name, ".") != 0 && 
            strcmp(directory_entry->d_name, "..") != 0) {
            collections[current_index] = strdup(directory_entry->d_name);
            if (!collections[current_index]) {
                // Cleanup on allocation failure
                for (int i = 0; i < current_index; i++) {
                    free(collections[i]);
                }
                free(collections);
                closedir(directory_pointer);
                *count = 0;
                return NULL;
            }
            current_index++;
        }
    }
    closedir(directory_pointer);
    
    *count = collection_count;
    return collections;
}

// ==================== INSTANCE OPERATIONS ====================

char* build_instance_json(char **fields, char **values, int count) {
    char *json = malloc(MAX_LINE_LENGTH);
    if (!json) return NULL;
    
    strcpy(json, "{");
    
    for (int field_index = 0; field_index < count; field_index++) {
        if (field_index > 0) strcat(json, ",");
        
        // Skip empty values (like when Age- is provided without value)
        if (values[field_index] == NULL || strlen(values[field_index]) == 0) {
            continue;
        }
        
        // Check if value looks like JSON object/array
        if ((values[field_index][0] == '[' && values[field_index][strlen(values[field_index])-1] == ']') ||
            (values[field_index][0] == '{' && values[field_index][strlen(values[field_index])-1] == '}')) {
            snprintf(json + strlen(json), MAX_LINE_LENGTH - strlen(json), 
                    "\"%s\":%s", fields[field_index], values[field_index]);
        } else {
            // Check if it's a number
            char *end_pointer;
            strtol(values[field_index], &end_pointer, 10);
            if (*end_pointer == '\0') {
                // It's a number
                snprintf(json + strlen(json), MAX_LINE_LENGTH - strlen(json), 
                        "\"%s\":%s", fields[field_index], values[field_index]);
            } else {
                // It's a string
                snprintf(json + strlen(json), MAX_LINE_LENGTH - strlen(json), 
                        "\"%s\":\"%s\"", fields[field_index], values[field_index]);
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
    
    // Load schema and validate
    field_schema_t fields[MAX_FIELDS];
    int field_count = 0;
    if (load_schema(database_name, collection_name, fields, &field_count) == -1) {
        return -1;
    }
    
    if (validate_instance_against_schema(instance_json, fields, field_count) == -1) {
        fprintf(stderr, "Instance validation failed against schema\n");
        return -1;
    }
    
    char collection_path[MAX_PATH_LENGTH];
    snprintf(collection_path, MAX_PATH_LENGTH, "%s/%s/%s", 
             get_sydb_base_directory(), database_name, collection_name);
    
    char lock_file_path[MAX_PATH_LENGTH];
    snprintf(lock_file_path, MAX_PATH_LENGTH, "%s/.data.lock", collection_path);
    int lock_file_descriptor = acquire_lock(lock_file_path);
    if (lock_file_descriptor == -1) {
        return -1;
    }
    
    // Generate UUID and add to instance
    char uuid[UUID_SIZE];
    generate_uuid(uuid);
    
    char full_json[MAX_LINE_LENGTH];
    snprintf(full_json, sizeof(full_json), "{\"_id\":\"%s\",\"_created_at\":%ld,%s", 
             uuid, time(NULL), instance_json + 1);
    
    char data_file_path[MAX_PATH_LENGTH];
    snprintf(data_file_path, MAX_PATH_LENGTH, "%s/data.txt", collection_path);
    
    FILE *file_pointer = fopen(data_file_path, "a");
    if (!file_pointer) {
        fprintf(stderr, "Error opening data file: %s\n", strerror(errno));
        release_lock(lock_file_descriptor, lock_file_path);
        return -1;
    }
    
    fprintf(file_pointer, "%s\n", full_json);
    fflush(file_pointer);
    fsync(fileno(file_pointer));
    fclose(file_pointer);
    
    release_lock(lock_file_descriptor, lock_file_path);
    
    printf("Instance inserted successfully with ID: %s\n", uuid);
    return 0;
}

int instance_update(const char *database_name, const char *collection_name, 
                   const char *query, char *update_json) {
    if (!database_exists(database_name) || !collection_exists(database_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        return -1;
    }
    
    // Load schema and validate update against schema
    field_schema_t fields[MAX_FIELDS];
    int field_count = 0;
    if (load_schema(database_name, collection_name, fields, &field_count) == 0) {
        // Create a temporary instance JSON with the update data to validate
        char temporary_instance[MAX_LINE_LENGTH];
        snprintf(temporary_instance, sizeof(temporary_instance), "{%s}", update_json + 1);
        if (validate_instance_against_schema(temporary_instance, fields, field_count) == -1) {
            fprintf(stderr, "Update validation failed against schema\n");
            return -1;
        }
    }
    
    char collection_path[MAX_PATH_LENGTH];
    snprintf(collection_path, MAX_PATH_LENGTH, "%s/%s/%s", 
             get_sydb_base_directory(), database_name, collection_name);
    
    char lock_file_path[MAX_PATH_LENGTH];
    snprintf(lock_file_path, MAX_PATH_LENGTH, "%s/.data.lock", collection_path);
    int lock_file_descriptor = acquire_lock(lock_file_path);
    if (lock_file_descriptor == -1) {
        return -1;
    }
    
    char data_file_path[MAX_PATH_LENGTH];
    snprintf(data_file_path, MAX_PATH_LENGTH, "%s/data.txt", collection_path);
    char temporary_file_path[MAX_PATH_LENGTH];
    snprintf(temporary_file_path, MAX_PATH_LENGTH, "%s/data.tmp", collection_path);
    
    FILE *file_pointer = fopen(data_file_path, "r");
    FILE *temporary_file_pointer = fopen(temporary_file_path, "w");
    if (!file_pointer || !temporary_file_pointer) {
        fprintf(stderr, "Error opening files: %s\n", strerror(errno));
        if (file_pointer) fclose(file_pointer);
        if (temporary_file_pointer) fclose(temporary_file_pointer);
        release_lock(lock_file_descriptor, lock_file_path);
        return -1;
    }
    
    char line_buffer[MAX_LINE_LENGTH];
    int updated_count = 0;
    
    while (fgets(line_buffer, sizeof(line_buffer), file_pointer)) {
        line_buffer[strcspn(line_buffer, "\n")] = '\0';
        
        if (json_matches_query(line_buffer, query)) {
            // Merge update with existing data
            char *update_data = update_json + 1;
            update_data[strlen(update_data)-1] = '\0';
            
            char *insert_position = strchr(line_buffer, ',');
            if (insert_position) {
                insert_position++;
                
                char new_line[MAX_LINE_LENGTH];
                strncpy(new_line, line_buffer, insert_position - line_buffer);
                new_line[insert_position - line_buffer] = '\0';
                strcat(new_line, update_data);
                strcat(new_line, "}");
                
                fprintf(temporary_file_pointer, "%s\n", new_line);
            } else {
                fprintf(temporary_file_pointer, "%s\n", line_buffer);
            }
            updated_count++;
        } else {
            fprintf(temporary_file_pointer, "%s\n", line_buffer);
        }
    }
    
    fclose(file_pointer);
    fclose(temporary_file_pointer);
    
    if (updated_count > 0) {
        rename(temporary_file_path, data_file_path);
        printf("Updated %d instance(s)\n", updated_count);
    } else {
        remove(temporary_file_path);
        printf("No instances found matching query\n");
    }
    
    release_lock(lock_file_descriptor, lock_file_path);
    return updated_count > 0 ? 0 : -1;
}

int instance_delete(const char *database_name, const char *collection_name, const char *query) {
    if (!database_exists(database_name) || !collection_exists(database_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        return -1;
    }
    
    char collection_path[MAX_PATH_LENGTH];
    snprintf(collection_path, MAX_PATH_LENGTH, "%s/%s/%s", 
             get_sydb_base_directory(), database_name, collection_name);
    
    char lock_file_path[MAX_PATH_LENGTH];
    snprintf(lock_file_path, MAX_PATH_LENGTH, "%s/.data.lock", collection_path);
    int lock_file_descriptor = acquire_lock(lock_file_path);
    if (lock_file_descriptor == -1) {
        return -1;
    }
    
    char data_file_path[MAX_PATH_LENGTH];
    snprintf(data_file_path, MAX_PATH_LENGTH, "%s/data.txt", collection_path);
    char temporary_file_path[MAX_PATH_LENGTH];
    snprintf(temporary_file_path, MAX_PATH_LENGTH, "%s/data.tmp", collection_path);
    
    FILE *file_pointer = fopen(data_file_path, "r");
    FILE *temporary_file_pointer = fopen(temporary_file_path, "w");
    if (!file_pointer || !temporary_file_pointer) {
        fprintf(stderr, "Error opening files: %s\n", strerror(errno));
        if (file_pointer) fclose(file_pointer);
        if (temporary_file_pointer) fclose(temporary_file_pointer);
        release_lock(lock_file_descriptor, lock_file_path);
        return -1;
    }
    
    char line_buffer[MAX_LINE_LENGTH];
    int deleted_count = 0;
    
    while (fgets(line_buffer, sizeof(line_buffer), file_pointer)) {
        line_buffer[strcspn(line_buffer, "\n")] = '\0';
        
        if (!json_matches_query(line_buffer, query)) {
            fprintf(temporary_file_pointer, "%s\n", line_buffer);
        } else {
            deleted_count++;
        }
    }
    
    fclose(file_pointer);
    fclose(temporary_file_pointer);
    
    if (deleted_count > 0) {
        rename(temporary_file_path, data_file_path);
        printf("Deleted %d instance(s)\n", deleted_count);
    } else {
        remove(temporary_file_path);
        printf("No instances found matching query\n");
    }
    
    release_lock(lock_file_descriptor, lock_file_path);
    return deleted_count > 0 ? 0 : -1;
}

char** instance_find(const char *database_name, const char *collection_name, const char *query, int *count) {
    if (!database_exists(database_name) || !collection_exists(database_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        *count = 0;
        return NULL;
    }
    
    char data_file_path[MAX_PATH_LENGTH];
    snprintf(data_file_path, MAX_PATH_LENGTH, "%s/%s/%s/data.txt", 
             get_sydb_base_directory(), database_name, collection_name);
    
    FILE *file_pointer = fopen(data_file_path, "r");
    if (!file_pointer) {
        *count = 0;
        return NULL;
    }
    
    // First pass: count matching instances
    char line_buffer[MAX_LINE_LENGTH];
    int matching_count = 0;
    
    while (fgets(line_buffer, sizeof(line_buffer), file_pointer)) {
        line_buffer[strcspn(line_buffer, "\n")] = '\0';
        if (json_matches_query(line_buffer, query)) {
            matching_count++;
        }
    }
    
    if (matching_count == 0) {
        fclose(file_pointer);
        *count = 0;
        return NULL;
    }
    
    // Second pass: collect matching instances
    rewind(file_pointer);
    
    char **results = malloc(matching_count * sizeof(char*));
    if (!results) {
        fclose(file_pointer);
        *count = 0;
        return NULL;
    }
    
    int current_index = 0;
    while (fgets(line_buffer, sizeof(line_buffer), file_pointer) && current_index < matching_count) {
        line_buffer[strcspn(line_buffer, "\n")] = '\0';
        if (json_matches_query(line_buffer, query)) {
            results[current_index] = strdup(line_buffer);
            if (!results[current_index]) {
                // Cleanup on allocation failure
                for (int i = 0; i < current_index; i++) {
                    free(results[i]);
                }
                free(results);
                fclose(file_pointer);
                *count = 0;
                return NULL;
            }
            current_index++;
        }
    }
    
    fclose(file_pointer);
    *count = current_index;
    return results;
}

char** instance_list(const char *database_name, const char *collection_name, int *count) {
    char data_file_path[MAX_PATH_LENGTH];
    snprintf(data_file_path, MAX_PATH_LENGTH, "%s/%s/%s/data.txt", 
             get_sydb_base_directory(), database_name, collection_name);
    
    FILE *file_pointer = fopen(data_file_path, "r");
    if (!file_pointer) {
        *count = 0;
        return NULL;
    }
    
    char line_buffer[MAX_LINE_LENGTH];
    int instance_count = 0;
    
    // First pass: count instances
    while (fgets(line_buffer, sizeof(line_buffer), file_pointer)) {
        instance_count++;
    }
    rewind(file_pointer);
    
    if (instance_count == 0) {
        fclose(file_pointer);
        *count = 0;
        return NULL;
    }
    
    char **instances = malloc(instance_count * sizeof(char*));
    if (!instances) {
        fclose(file_pointer);
        *count = 0;
        return NULL;
    }
    
    int current_index = 0;
    while (fgets(line_buffer, sizeof(line_buffer), file_pointer) && current_index < instance_count) {
        line_buffer[strcspn(line_buffer, "\n")] = '\0';
        
        // Store the full JSON data instead of just the ID
        instances[current_index] = strdup(line_buffer);
        if (!instances[current_index]) {
            // Cleanup on allocation failure
            for (int i = 0; i < current_index; i++) {
                free(instances[i]);
            }
            free(instances);
            fclose(file_pointer);
            *count = 0;
            return NULL;
        }
        current_index++;
    }
    fclose(file_pointer);
    
    *count = current_index;
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

int parse_insert_data(int argument_count, char *argument_values[], int start_index, 
                     char **fields, char **values, int *count) {
    *count = 0;
    
    for (int argument_index = start_index; 
         argument_index < argument_count && *count < MAX_FIELDS; 
         argument_index++) {
        char *field_specification = argument_values[argument_index];
        if (strncmp(field_specification, "--", 2) != 0) continue;
        
        field_specification += 2;
        
        char *value_start = strchr(field_specification, '-');
        if (!value_start) {
            // Handle case like --Name"testando" (missing dash)
            continue;
        }
        
        *value_start = '\0';
        char *field_value = value_start + 1;
        
        // Handle case where there's no value after dash (like --Age-)
        if (strlen(field_value) == 0) {
            fields[*count] = strdup(field_specification);
            values[*count] = strdup(""); // Empty value
        } else {
            // Remove surrounding quotes if present
            if (field_value[0] == '"' && field_value[strlen(field_value)-1] == '"') {
                field_value[strlen(field_value)-1] = '\0';
                field_value++;
            }
            
            fields[*count] = strdup(field_specification);
            values[*count] = strdup(field_value);
        }
        
        if (!fields[*count] || !values[*count]) {
            // Cleanup on allocation failure
            for (int i = 0; i < *count; i++) {
                free(fields[i]);
                free(values[i]);
            }
            return -1;
        }
        
        (*count)++;
    }
    
    return 0;
}

int main(int argument_count, char *argument_values[]) {
    if (argument_count < 2) {
        print_usage();
        return 1;
    }
    
    create_directory(get_sydb_base_directory());
    
    if (strcmp(argument_values[1], "create") == 0) {
        if (argument_count < 3) {
            fprintf(stderr, "Error: Missing database name\n");
            print_usage();
            return 1;
        }
        
        if (argument_count == 3) {
            return database_create(argument_values[2]);
        }
        else if (argument_count >= 5) {
            int schema_flag_index = -1;
            int insert_flag_index = -1;
            
            for (int argument_index = 3; argument_index < argument_count; argument_index++) {
                if (strcmp(argument_values[argument_index], "--schema") == 0) {
                    schema_flag_index = argument_index;
                    break;
                } else if (strcmp(argument_values[argument_index], "--insert-one") == 0) {
                    insert_flag_index = argument_index;
                    break;
                }
            }
            
            if (schema_flag_index != -1) {
                if (schema_flag_index != 4) {
                    fprintf(stderr, "Error: Invalid syntax. Use: sydb create <db> <collection> --schema ...\n");
                    print_usage();
                    return 1;
                }
                
                if (argument_count < 6) {
                    fprintf(stderr, "Error: Missing schema fields\n");
                    print_usage();
                    return 1;
                }
                
                field_schema_t fields[MAX_FIELDS];
                int field_count = 0;
                if (parse_schema_fields(argument_count, argument_values, schema_flag_index + 1, 
                                       fields, &field_count) == -1) {
                    return 1;
                }
                
                if (field_count == 0) {
                    fprintf(stderr, "Error: No valid schema fields provided\n");
                    return 1;
                }
                
                return collection_create(argument_values[2], argument_values[3], fields, field_count);
            }
            else if (insert_flag_index != -1) {
                if (insert_flag_index != 4) {
                    fprintf(stderr, "Error: Invalid syntax. Use: sydb create <db> <collection> --insert-one ...\n");
                    print_usage();
                    return 1;
                }
                
                if (argument_count < 6) {
                    fprintf(stderr, "Error: Missing insert data\n");
                    print_usage();
                    return 1;
                }
                
                char *fields[MAX_FIELDS];
                char *values[MAX_FIELDS];
                int field_count = 0;
                
                if (parse_insert_data(argument_count, argument_values, insert_flag_index + 1, 
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
                
                int result = instance_insert(argument_values[2], argument_values[3], instance_json);
                
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
    else if (strcmp(argument_values[1], "update") == 0) {
        if (argument_count < 7 || strcmp(argument_values[4], "--where") != 0 || 
            strcmp(argument_values[6], "--set") != 0) {
            fprintf(stderr, "Error: Invalid update syntax\n");
            print_usage();
            return 1;
        }
        
        char *fields[MAX_FIELDS];
        char *values[MAX_FIELDS];
        int field_count = 0;
        
        if (parse_insert_data(argument_count, argument_values, 7, fields, values, &field_count) == -1) {
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
        
        int result = instance_update(argument_values[2], argument_values[3], argument_values[5], update_json);
        
        free(update_json);
        for (int i = 0; i < field_count; i++) {
            free(fields[i]);
            free(values[i]);
        }
        
        return result;
    }
    else if (strcmp(argument_values[1], "delete") == 0) {
        if (argument_count < 6 || strcmp(argument_values[4], "--where") != 0) {
            fprintf(stderr, "Error: Invalid delete syntax\n");
            print_usage();
            return 1;
        }
        
        return instance_delete(argument_values[2], argument_values[3], argument_values[5]);
    }
    else if (strcmp(argument_values[1], "find") == 0) {
        if (argument_count < 6 || strcmp(argument_values[4], "--where") != 0) {
            fprintf(stderr, "Error: Invalid find syntax\n");
            print_usage();
            return 1;
        }
        
        int result_count;
        char **results = instance_find(argument_values[2], argument_values[3], argument_values[5], &result_count);
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
    else if (strcmp(argument_values[1], "schema") == 0) {
        if (argument_count < 4) {
            fprintf(stderr, "Error: Missing database or collection name\n");
            print_usage();
            return 1;
        }
        
        print_schema(argument_values[2], argument_values[3]);
        return 0;
    }
    else if (strcmp(argument_values[1], "list") == 0) {
        if (argument_count == 2) {
            int database_count;
            char **databases = database_list(&database_count);
            if (database_count == 0) {
                printf("No databases found\n");
            } else {
                printf("Databases:\n");
                for (int database_index = 0; database_index < database_count; database_index++) {
                    printf("  %s\n", databases[database_index]);
                    free(databases[database_index]);
                }
                free(databases);
            }
            return 0;
        }
        else if (argument_count == 3) {
            int collection_count;
            char **collections = collection_list(argument_values[2], &collection_count);
            if (collection_count == 0) {
                printf("No collections found in database '%s'\n", argument_values[2]);
            } else {
                printf("Collections in database '%s':\n", argument_values[2]);
                for (int collection_index = 0; collection_index < collection_count; collection_index++) {
                    printf("  %s\n", collections[collection_index]);
                    free(collections[collection_index]);
                }
                free(collections);
            }
            return 0;
        }
        else if (argument_count == 4) {
            int instance_count;
            char **instances = instance_list(argument_values[2], argument_values[3], &instance_count);
            if (instance_count == 0) {
                printf("No instances found in collection '%s'\n", argument_values[3]);
            } else {
                printf("Instances in collection '%s':\n", argument_values[3]);
                for (int instance_index = 0; instance_index < instance_count; instance_index++) {
                    printf("  %s\n", instances[instance_index]);
                    free(instances[instance_index]);
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
        fprintf(stderr, "Error: Unknown command '%s'\n", argument_values[1]);
        print_usage();
        return 1;
    }
    
    return 0;
}
