#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>
#include <unistd.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/mman.h>
#include <time.h>
#include <errno.h>
#include <fcntl.h>

// ==================== CONSTANTS AND CONFIGURATION ====================

#define MAXIMUM_NAME_LENGTH 256
#define MAXIMUM_FIELD_LENGTH 64
#define MAXIMUM_FIELDS 32
#define MAXIMUM_PATH_LENGTH 1024
#define MAXIMUM_LINE_LENGTH 4096
#define UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE 37
#define DATABASE_BASE_DIRECTORY "/var/lib/sydb"
#define LOCK_TIMEOUT_SECONDS 30
#define DATA_FILE_EXTENSION ".sydb"
#define INITIAL_FILE_SIZE_BYTES (1024 * 1024) // 1MB initial size
#define FILE_GROWTH_FACTOR 2
#define FILE_FORMAT_MAGIC_NUMBER 0x53594442 // "SYDB" in hex
#define FILE_FORMAT_VERSION 1

// ==================== DATA STRUCTURES ====================

typedef enum {
    FIELD_TYPE_STRING,
    FIELD_TYPE_INTEGER,
    FIELD_TYPE_FLOATING_POINT,
    FIELD_TYPE_BOOLEAN,
    FIELD_TYPE_ARRAY,
    FIELD_TYPE_OBJECT,
    FIELD_TYPE_NULL
} FieldType;

typedef struct {
    char field_name[MAXIMUM_FIELD_LENGTH];
    FieldType field_type;
    bool field_required;
} FieldSchema;

typedef struct {
    char instance_universally_unique_identifier[UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE];
    char *instance_data;
    size_t instance_data_length;
} DatabaseInstance;

typedef struct {
    uint32_t file_magic_number;
    uint32_t file_format_version;
    uint64_t total_record_count;
    uint64_t total_file_size_bytes;
    uint64_t next_free_offset_bytes;
    uint64_t schema_checksum;
} FileHeader;

typedef struct {
    uint64_t record_total_size_bytes;
    uint64_t record_data_offset_bytes;
    uint64_t record_creation_timestamp;
    char record_universally_unique_identifier[UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE];
    uint32_t record_flags;
    uint32_t record_data_checksum;
} RecordHeader;

typedef struct {
    int file_descriptor;
    void *memory_mapped_region;
    size_t memory_mapped_region_size;
    FileHeader *file_header_pointer;
} MemoryMappedFile;

typedef struct {
    MemoryMappedFile *memory_mapped_file_reference;
    uint64_t current_record_offset_bytes;
    uint64_t processed_record_count;
} RecordIterator;

// ==================== BINARY STORAGE CORE ====================

uint32_t compute_data_checksum(const void *input_data, size_t data_length) {
    const uint8_t *data_bytes = (const uint8_t *)input_data;
    uint32_t checksum = 0xFFFFFFFF;
    
    for (size_t byte_index = 0; byte_index < data_length; byte_index++) {
        checksum ^= data_bytes[byte_index];
        for (int bit_index = 0; bit_index < 8; bit_index++) {
            checksum = (checksum >> 1) ^ (0xEDB88320 & -(checksum & 1));
        }
    }
    
    return ~checksum;
}

MemoryMappedFile* open_memory_mapped_database_file(const char *file_path, bool create_new_file) {
    MemoryMappedFile *memory_mapped_file = malloc(sizeof(MemoryMappedFile));
    if (!memory_mapped_file) {
        return NULL;
    }
    
    int open_flags = create_new_file ? (O_RDWR | O_CREAT) : O_RDWR;
    memory_mapped_file->file_descriptor = open(file_path, open_flags, 0644);
    if (memory_mapped_file->file_descriptor == -1) {
        free(memory_mapped_file);
        return NULL;
    }
    
    if (create_new_file) {
        if (ftruncate(memory_mapped_file->file_descriptor, INITIAL_FILE_SIZE_BYTES) == -1) {
            close(memory_mapped_file->file_descriptor);
            free(memory_mapped_file);
            return NULL;
        }
    }
    
    struct stat file_statistics;
    if (fstat(memory_mapped_file->file_descriptor, &file_statistics) == -1) {
        close(memory_mapped_file->file_descriptor);
        free(memory_mapped_file);
        return NULL;
    }
    
    memory_mapped_file->memory_mapped_region_size = file_statistics.st_size;
    if (memory_mapped_file->memory_mapped_region_size == 0) {
        if (ftruncate(memory_mapped_file->file_descriptor, INITIAL_FILE_SIZE_BYTES) == -1) {
            close(memory_mapped_file->file_descriptor);
            free(memory_mapped_file);
            return NULL;
        }
        memory_mapped_file->memory_mapped_region_size = INITIAL_FILE_SIZE_BYTES;
    }
    
    memory_mapped_file->memory_mapped_region = mmap(
        NULL, 
        memory_mapped_file->memory_mapped_region_size, 
        PROT_READ | PROT_WRITE, 
        MAP_SHARED, 
        memory_mapped_file->file_descriptor, 
        0
    );
    
    if (memory_mapped_file->memory_mapped_region == MAP_FAILED) {
        close(memory_mapped_file->file_descriptor);
        free(memory_mapped_file);
        return NULL;
    }
    
    memory_mapped_file->file_header_pointer = (FileHeader*)memory_mapped_file->memory_mapped_region;
    
    if (create_new_file && memory_mapped_file->file_header_pointer->file_magic_number != FILE_FORMAT_MAGIC_NUMBER) {
        memory_mapped_file->file_header_pointer->file_magic_number = FILE_FORMAT_MAGIC_NUMBER;
        memory_mapped_file->file_header_pointer->file_format_version = FILE_FORMAT_VERSION;
        memory_mapped_file->file_header_pointer->total_record_count = 0;
        memory_mapped_file->file_header_pointer->total_file_size_bytes = memory_mapped_file->memory_mapped_region_size;
        memory_mapped_file->file_header_pointer->next_free_offset_bytes = sizeof(FileHeader);
        memory_mapped_file->file_header_pointer->schema_checksum = 0;
    }
    
    return memory_mapped_file;
}

void close_memory_mapped_database_file(MemoryMappedFile *memory_mapped_file) {
    if (memory_mapped_file) {
        if (memory_mapped_file->memory_mapped_region && memory_mapped_file->memory_mapped_region != MAP_FAILED) {
            msync(memory_mapped_file->memory_mapped_region, memory_mapped_file->memory_mapped_region_size, MS_SYNC);
            munmap(memory_mapped_file->memory_mapped_region, memory_mapped_file->memory_mapped_region_size);
        }
        if (memory_mapped_file->file_descriptor != -1) {
            close(memory_mapped_file->file_descriptor);
        }
        free(memory_mapped_file);
    }
}

int expand_memory_mapped_file_size(MemoryMappedFile *memory_mapped_file, size_t minimum_required_size) {
    size_t new_file_size = memory_mapped_file->memory_mapped_region_size;
    while (new_file_size < minimum_required_size) {
        new_file_size *= FILE_GROWTH_FACTOR;
    }
    
    if (ftruncate(memory_mapped_file->file_descriptor, new_file_size) == -1) {
        return -1;
    }
    
    munmap(memory_mapped_file->memory_mapped_region, memory_mapped_file->memory_mapped_region_size);
    
    memory_mapped_file->memory_mapped_region = mmap(
        NULL, 
        new_file_size, 
        PROT_READ | PROT_WRITE, 
        MAP_SHARED, 
        memory_mapped_file->file_descriptor, 
        0
    );
    
    if (memory_mapped_file->memory_mapped_region == MAP_FAILED) {
        return -1;
    }
    
    memory_mapped_file->memory_mapped_region_size = new_file_size;
    memory_mapped_file->file_header_pointer = (FileHeader*)memory_mapped_file->memory_mapped_region;
    memory_mapped_file->file_header_pointer->total_file_size_bytes = new_file_size;
    
    return 0;
}

uint64_t append_database_record(MemoryMappedFile *memory_mapped_file, const char *universally_unique_identifier, const char *json_data, size_t json_data_length) {
    size_t total_record_size = sizeof(RecordHeader) + json_data_length + 1;
    
    if (memory_mapped_file->file_header_pointer->next_free_offset_bytes + total_record_size > memory_mapped_file->memory_mapped_region_size) {
        if (expand_memory_mapped_file_size(memory_mapped_file, memory_mapped_file->file_header_pointer->next_free_offset_bytes + total_record_size) == -1) {
            return 0;
        }
    }
    
    uint64_t record_offset = memory_mapped_file->file_header_pointer->next_free_offset_bytes;
    RecordHeader *record_header = (RecordHeader*)((char*)memory_mapped_file->memory_mapped_region + record_offset);
    char *data_pointer = (char*)memory_mapped_file->memory_mapped_region + record_offset + sizeof(RecordHeader);
    
    record_header->record_total_size_bytes = total_record_size;
    record_header->record_data_offset_bytes = record_offset + sizeof(RecordHeader);
    record_header->record_creation_timestamp = time(NULL);
    strncpy(record_header->record_universally_unique_identifier, universally_unique_identifier, UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE - 1);
    record_header->record_universally_unique_identifier[UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE - 1] = '\0';
    record_header->record_flags = 0;
    
    memcpy(data_pointer, json_data, json_data_length);
    data_pointer[json_data_length] = '\0';
    
    record_header->record_data_checksum = compute_data_checksum(json_data, json_data_length);
    
    memory_mapped_file->file_header_pointer->next_free_offset_bytes += total_record_size;
    memory_mapped_file->file_header_pointer->total_record_count++;
    
    return record_offset;
}

RecordIterator* create_database_record_iterator(MemoryMappedFile *memory_mapped_file) {
    RecordIterator *iterator = malloc(sizeof(RecordIterator));
    if (!iterator) {
        return NULL;
    }
    
    iterator->memory_mapped_file_reference = memory_mapped_file;
    iterator->current_record_offset_bytes = sizeof(FileHeader);
    iterator->processed_record_count = 0;
    
    return iterator;
}

void destroy_database_record_iterator(RecordIterator *iterator) {
    free(iterator);
}

RecordHeader* retrieve_next_database_record(RecordIterator *iterator) {
    if (iterator->processed_record_count >= iterator->memory_mapped_file_reference->file_header_pointer->total_record_count) {
        return NULL;
    }
    
    if (iterator->current_record_offset_bytes >= iterator->memory_mapped_file_reference->file_header_pointer->next_free_offset_bytes) {
        return NULL;
    }
    
    RecordHeader *record_header = (RecordHeader*)((char*)iterator->memory_mapped_file_reference->memory_mapped_region + iterator->current_record_offset_bytes);
    
    if (record_header->record_total_size_bytes == 0 || record_header->record_total_size_bytes > iterator->memory_mapped_file_reference->memory_mapped_region_size) {
        return NULL;
    }
    
    iterator->current_record_offset_bytes += record_header->record_total_size_bytes;
    iterator->processed_record_count++;
    
    return record_header;
}

char* extract_json_data_from_record(RecordHeader *record_header) {
    return (char*)record_header + record_header->record_data_offset_bytes;
}

// ==================== UTILITY FUNCTIONS ====================

void generate_universally_unique_identifier(char *universally_unique_identifier_buffer) {
    const char *hexadecimal_characters = "0123456789abcdef";
    int segment_lengths[] = {8, 4, 4, 4, 12};
    int current_position = 0;
    
    srand(time(NULL) + getpid() + rand());
    
    for (int segment_index = 0; segment_index < 5; segment_index++) {
        if (segment_index > 0) {
            universally_unique_identifier_buffer[current_position++] = '-';
        }
        for (int character_index = 0; character_index < segment_lengths[segment_index]; character_index++) {
            universally_unique_identifier_buffer[current_position++] = hexadecimal_characters[rand() % 16];
        }
    }
    universally_unique_identifier_buffer[current_position] = '\0';
}

int ensure_directory_exists(const char *directory_path) {
    struct stat directory_status;
    if (stat(directory_path, &directory_status) == -1) {
        if (mkdir(directory_path, 0755) == -1) {
            fprintf(stderr, "Error creating directory %s: %s\n", directory_path, strerror(errno));
            return -1;
        }
    }
    return 0;
}

int acquire_exclusive_lock(const char *lock_file_path) {
    int lock_file_descriptor = open(lock_file_path, O_CREAT | O_RDWR, 0644);
    if (lock_file_descriptor == -1) {
        fprintf(stderr, "Error creating lock file %s: %s\n", lock_file_path, strerror(errno));
        return -1;
    }
    
    struct timespec lock_timeout;
    clock_gettime(CLOCK_REALTIME, &lock_timeout);
    lock_timeout.tv_sec += LOCK_TIMEOUT_SECONDS;
    
    if (flock(lock_file_descriptor, LOCK_EX | LOCK_NB) == -1) {
        if (errno == EWOULDBLOCK) {
            fprintf(stderr, "Timeout: Could not acquire lock on %s after %d seconds\n", lock_file_path, LOCK_TIMEOUT_SECONDS);
            close(lock_file_descriptor);
            return -1;
        }
    }
    
    return lock_file_descriptor;
}

void release_exclusive_lock(int lock_file_descriptor, const char *lock_file_path) {
    if (lock_file_descriptor != -1) {
        flock(lock_file_descriptor, LOCK_UN);
        close(lock_file_descriptor);
    }
}

char* get_database_base_directory_path() {
    static char base_directory_path[MAXIMUM_PATH_LENGTH];
    const char *environment_directory = getenv("SYDB_BASE_DIR");
    if (environment_directory) {
        strncpy(base_directory_path, environment_directory, MAXIMUM_PATH_LENGTH - 1);
        base_directory_path[MAXIMUM_PATH_LENGTH - 1] = '\0';
    } else {
        strncpy(base_directory_path, DATABASE_BASE_DIRECTORY, MAXIMUM_PATH_LENGTH - 1);
        base_directory_path[MAXIMUM_PATH_LENGTH - 1] = '\0';
    }
    return base_directory_path;
}

// ==================== JSON PROCESSING FUNCTIONS ====================

char* extract_json_string_value(const char *json_data, const char *target_key) {
    char search_pattern[256];
    snprintf(search_pattern, sizeof(search_pattern), "\"%s\":\"", target_key);
    char *value_start_position = strstr(json_data, search_pattern);
    if (!value_start_position) {
        return NULL;
    }
    
    value_start_position += strlen(search_pattern);
    char *value_end_position = strchr(value_start_position, '"');
    if (!value_end_position) {
        return NULL;
    }
    
    size_t value_length = value_end_position - value_start_position;
    char *extracted_value = malloc(value_length + 1);
    if (!extracted_value) {
        return NULL;
    }
    
    strncpy(extracted_value, value_start_position, value_length);
    extracted_value[value_length] = '\0';
    return extracted_value;
}

int extract_json_integer_value(const char *json_data, const char *target_key) {
    char search_pattern[256];
    snprintf(search_pattern, sizeof(search_pattern), "\"%s\":", target_key);
    char *value_start_position = strstr(json_data, search_pattern);
    if (!value_start_position) {
        return 0;
    }
    
    value_start_position += strlen(search_pattern);
    return atoi(value_start_position);
}

bool check_json_field_existence(const char *json_data, const char *target_key) {
    char search_pattern[256];
    snprintf(search_pattern, sizeof(search_pattern), "\"%s\":", target_key);
    return strstr(json_data, search_pattern) != NULL;
}

bool evaluate_json_query_condition(const char *json_data, const char *query_condition) {
    if (!query_condition || !json_data) {
        return false;
    }
    
    char query_copy[1024];
    strncpy(query_copy, query_condition, sizeof(query_copy) - 1);
    query_copy[sizeof(query_copy) - 1] = '\0';
    
    char *current_token = strtok(query_copy, ",");
    while (current_token) {
        while (*current_token == ' ') {
            current_token++;
        }
        
        char *colon_position = strchr(current_token, ':');
        if (!colon_position) {
            current_token = strtok(NULL, ",");
            continue;
        }
        
        *colon_position = '\0';
        char *field_name = current_token;
        char *expected_value = colon_position + 1;
        
        if (expected_value[0] == '"' && expected_value[strlen(expected_value)-1] == '"') {
            expected_value[strlen(expected_value)-1] = '\0';
            expected_value++;
        }
        
        char *actual_string_value = extract_json_string_value(json_data, field_name);
        if (actual_string_value) {
            bool matches = (strcmp(actual_string_value, expected_value) == 0);
            free(actual_string_value);
            if (!matches) {
                return false;
            }
        } else {
            int actual_integer_value = extract_json_integer_value(json_data, field_name);
            int expected_integer_value = atoi(expected_value);
            if (actual_integer_value != expected_integer_value) {
                return false;
            }
        }
        
        current_token = strtok(NULL, ",");
    }
    
    return true;
}

// ==================== SCHEMA MANAGEMENT FUNCTIONS ====================

FieldType parse_field_type_string(const char *type_string) {
    if (strcmp(type_string, "string") == 0) return FIELD_TYPE_STRING;
    if (strcmp(type_string, "int") == 0) return FIELD_TYPE_INTEGER;
    if (strcmp(type_string, "float") == 0) return FIELD_TYPE_FLOATING_POINT;
    if (strcmp(type_string, "bool") == 0) return FIELD_TYPE_BOOLEAN;
    if (strcmp(type_string, "array") == 0) return FIELD_TYPE_ARRAY;
    if (strcmp(type_string, "object") == 0) return FIELD_TYPE_OBJECT;
    return FIELD_TYPE_NULL;
}

const char* convert_field_type_to_string(FieldType field_type) {
    switch (field_type) {
        case FIELD_TYPE_STRING: return "string";
        case FIELD_TYPE_INTEGER: return "int";
        case FIELD_TYPE_FLOATING_POINT: return "float";
        case FIELD_TYPE_BOOLEAN: return "bool";
        case FIELD_TYPE_ARRAY: return "array";
        case FIELD_TYPE_OBJECT: return "object";
        default: return "null";
    }
}

int parse_schema_field_definitions(int argument_count, char *argument_array[], int starting_index, 
                                  FieldSchema *field_schema_array, int *field_count_output) {
    *field_count_output = 0;
    
    for (int argument_index = starting_index; 
         argument_index < argument_count && *field_count_output < MAXIMUM_FIELDS; 
         argument_index++) {
        char *field_definition = argument_array[argument_index];
        if (strncmp(field_definition, "--", 2) != 0) {
            continue;
        }
        
        field_definition += 2;
        
        char field_name[MAXIMUM_FIELD_LENGTH];
        char field_type_string[32];
        bool field_required = false;
        
        char *first_dash = strchr(field_definition, '-');
        if (!first_dash) {
            continue;
        }
        
        *first_dash = '\0';
        strncpy(field_name, field_definition, MAXIMUM_FIELD_LENGTH - 1);
        field_name[MAXIMUM_FIELD_LENGTH - 1] = '\0';
        
        char *second_dash = strchr(first_dash + 1, '-');
        if (second_dash) {
            *second_dash = '\0';
            strncpy(field_type_string, first_dash + 1, sizeof(field_type_string) - 1);
            field_type_string[sizeof(field_type_string) - 1] = '\0';
            field_required = (strcmp(second_dash + 1, "req") == 0);
        } else {
            strncpy(field_type_string, first_dash + 1, sizeof(field_type_string) - 1);
            field_type_string[sizeof(field_type_string) - 1] = '\0';
            field_required = false;
        }
        
        FieldType parsed_type = parse_field_type_string(field_type_string);
        if (parsed_type == FIELD_TYPE_NULL) {
            fprintf(stderr, "Error: Unknown field type '%s' for field '%s'\n", field_type_string, field_name);
            return -1;
        }
        
        strncpy(field_schema_array[*field_count_output].field_name, field_name, MAXIMUM_FIELD_LENGTH - 1);
        field_schema_array[*field_count_output].field_name[MAXIMUM_FIELD_LENGTH - 1] = '\0';
        field_schema_array[*field_count_output].field_type = parsed_type;
        field_schema_array[*field_count_output].field_required = field_required;
        (*field_count_output)++;
    }
    
    return 0;
}

int load_collection_schema(const char *database_name, const char *collection_name, 
                          FieldSchema *field_schema_array, int *field_count_output) {
    char schema_file_path[MAXIMUM_PATH_LENGTH];
    snprintf(schema_file_path, MAXIMUM_PATH_LENGTH, "%s/%s/%s/schema.txt", 
             get_database_base_directory_path(), database_name, collection_name);
    
    FILE *schema_file_pointer = fopen(schema_file_path, "r");
    if (!schema_file_pointer) {
        fprintf(stderr, "Error: Cannot load schema for collection '%s'\n", collection_name);
        return -1;
    }
    
    *field_count_output = 0;
    char line_buffer[256];
    
    while (fgets(line_buffer, sizeof(line_buffer), schema_file_pointer) && *field_count_output < MAXIMUM_FIELDS) {
        line_buffer[strcspn(line_buffer, "\n")] = '\0';
        
        char *first_colon = strchr(line_buffer, ':');
        char *second_colon = first_colon ? strchr(first_colon + 1, ':') : NULL;
        
        if (!first_colon || !second_colon) {
            continue;
        }
        
        *first_colon = '\0';
        *second_colon = '\0';
        
        char *field_name = line_buffer;
        char *type_string = first_colon + 1;
        char *required_string = second_colon + 1;
        
        strncpy(field_schema_array[*field_count_output].field_name, field_name, MAXIMUM_FIELD_LENGTH - 1);
        field_schema_array[*field_count_output].field_name[MAXIMUM_FIELD_LENGTH - 1] = '\0';
        field_schema_array[*field_count_output].field_type = parse_field_type_string(type_string);
        field_schema_array[*field_count_output].field_required = (strcmp(required_string, "required") == 0);
        (*field_count_output)++;
    }
    
    fclose(schema_file_pointer);
    return 0;
}

bool validate_field_value_type_compatibility(const char *field_name, const char *field_value, FieldType field_type) {
    if (!field_value || strlen(field_value) == 0) {
        return true;
    }
    
    switch (field_type) {
        case FIELD_TYPE_INTEGER: {
            char *validation_end_pointer;
            long integer_value = strtol(field_value, &validation_end_pointer, 10);
            if (*validation_end_pointer != '\0') {
                fprintf(stderr, "Validation error: Field '%s' should be integer but got '%s'\n", field_name, field_value);
                return false;
            }
            return true;
        }
        case FIELD_TYPE_FLOATING_POINT: {
            char *validation_end_pointer;
            double floating_point_value = strtod(field_value, &validation_end_pointer);
            if (*validation_end_pointer != '\0') {
                fprintf(stderr, "Validation error: Field '%s' should be float but got '%s'\n", field_name, field_value);
                return false;
            }
            return true;
        }
        case FIELD_TYPE_BOOLEAN: {
            if (strcmp(field_value, "true") != 0 && strcmp(field_value, "false") != 0 &&
                strcmp(field_value, "1") != 0 && strcmp(field_value, "0") != 0) {
                fprintf(stderr, "Validation error: Field '%s' should be boolean but got '%s'\n", field_name, field_value);
                return false;
            }
            return true;
        }
        case FIELD_TYPE_STRING:
        case FIELD_TYPE_ARRAY:
        case FIELD_TYPE_OBJECT:
        case FIELD_TYPE_NULL:
        default:
            return true;
    }
}

int validate_database_instance_against_schema(const char *instance_json_data, 
                                             FieldSchema *field_schema_array, int field_count) {
    for (int field_index = 0; field_index < field_count; field_index++) {
        if (field_schema_array[field_index].field_required && 
            !check_json_field_existence(instance_json_data, field_schema_array[field_index].field_name)) {
            fprintf(stderr, "Validation error: Required field '%s' is missing\n", field_schema_array[field_index].field_name);
            return -1;
        }
        
        if (check_json_field_existence(instance_json_data, field_schema_array[field_index].field_name)) {
            char *field_value = extract_json_string_value(instance_json_data, field_schema_array[field_index].field_name);
            if (field_value) {
                if (!validate_field_value_type_compatibility(field_schema_array[field_index].field_name, field_value, field_schema_array[field_index].field_type)) {
                    free(field_value);
                    return -1;
                }
                free(field_value);
            } else {
                int integer_value = extract_json_integer_value(instance_json_data, field_schema_array[field_index].field_name);
                if (field_schema_array[field_index].field_type == FIELD_TYPE_INTEGER) {
                    // Integer validation is handled during extraction
                }
            }
        }
    }
    return 0;
}

void display_collection_schema(const char *database_name, const char *collection_name) {
    FieldSchema field_schema_array[MAXIMUM_FIELDS];
    int field_count = 0;
    
    if (load_collection_schema(database_name, collection_name, field_schema_array, &field_count) == -1) {
        fprintf(stderr, "Error: Cannot load schema for collection '%s'\n", collection_name);
        return;
    }
    
    printf("Schema for collection '%s':\n", collection_name);
    printf("%-20s %-10s %-10s\n", "Field", "Type", "Required");
    printf("----------------------------------------\n");
    
    for (int field_index = 0; field_index < field_count; field_index++) {
        printf("%-20s %-10s %-10s\n", 
               field_schema_array[field_index].field_name, 
               convert_field_type_to_string(field_schema_array[field_index].field_type),
               field_schema_array[field_index].field_required ? "Yes" : "No");
    }
}

// ==================== DATABASE OPERATIONS ====================

int create_database(const char *database_name) {
    char base_directory_path[MAXIMUM_PATH_LENGTH];
    strncpy(base_directory_path, get_database_base_directory_path(), MAXIMUM_PATH_LENGTH - 1);
    base_directory_path[MAXIMUM_PATH_LENGTH - 1] = '\0';
    
    if (ensure_directory_exists(base_directory_path) == -1) {
        return -1;
    }
    
    char database_directory_path[MAXIMUM_PATH_LENGTH];
    snprintf(database_directory_path, MAXIMUM_PATH_LENGTH, "%s/%s", base_directory_path, database_name);
    
    if (ensure_directory_exists(database_directory_path) == -1) {
        return -1;
    }
    
    printf("Database '%s' created successfully at %s\n", database_name, database_directory_path);
    return 0;
}

int check_database_existence(const char *database_name) {
    char database_directory_path[MAXIMUM_PATH_LENGTH];
    snprintf(database_directory_path, MAXIMUM_PATH_LENGTH, "%s/%s", 
             get_database_base_directory_path(), database_name);
    
    struct stat directory_status;
    return (stat(database_directory_path, &directory_status) == 0 && S_ISDIR(directory_status.st_mode));
}

char** list_all_databases(int *database_count_output) {
    char base_directory_path[MAXIMUM_PATH_LENGTH];
    strncpy(base_directory_path, get_database_base_directory_path(), MAXIMUM_PATH_LENGTH - 1);
    base_directory_path[MAXIMUM_PATH_LENGTH - 1] = '\0';
    
    DIR *directory_pointer = opendir(base_directory_path);
    if (!directory_pointer) {
        *database_count_output = 0;
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
        *database_count_output = 0;
        return NULL;
    }
    
    char **database_names = malloc(database_count * sizeof(char*));
    if (!database_names) {
        closedir(directory_pointer);
        *database_count_output = 0;
        return NULL;
    }
    
    int current_index = 0;
    while ((directory_entry = readdir(directory_pointer)) != NULL && current_index < database_count) {
        if (directory_entry->d_type == DT_DIR && 
            strcmp(directory_entry->d_name, ".") != 0 && 
            strcmp(directory_entry->d_name, "..") != 0) {
            database_names[current_index] = strdup(directory_entry->d_name);
            if (!database_names[current_index]) {
                for (int cleanup_index = 0; cleanup_index < current_index; cleanup_index++) {
                    free(database_names[cleanup_index]);
                }
                free(database_names);
                closedir(directory_pointer);
                *database_count_output = 0;
                return NULL;
            }
            current_index++;
        }
    }
    closedir(directory_pointer);
    
    *database_count_output = database_count;
    return database_names;
}

// ==================== COLLECTION OPERATIONS ====================

int create_collection(const char *database_name, const char *collection_name, 
                     FieldSchema *field_schema_array, int field_count) {
    if (!check_database_existence(database_name)) {
        fprintf(stderr, "Database '%s' does not exist\n", database_name);
        return -1;
    }
    
    char database_directory_path[MAXIMUM_PATH_LENGTH];
    snprintf(database_directory_path, MAXIMUM_PATH_LENGTH, "%s/%s", 
             get_database_base_directory_path(), database_name);
    
    char collection_directory_path[MAXIMUM_PATH_LENGTH];
    snprintf(collection_directory_path, MAXIMUM_PATH_LENGTH, "%s/%s", database_directory_path, collection_name);
    
    if (ensure_directory_exists(collection_directory_path) == -1) {
        return -1;
    }
    
    char schema_file_path[MAXIMUM_PATH_LENGTH];
    snprintf(schema_file_path, MAXIMUM_PATH_LENGTH, "%s/schema.txt", collection_directory_path);
    
    char lock_file_path[MAXIMUM_PATH_LENGTH];
    snprintf(lock_file_path, MAXIMUM_PATH_LENGTH, "%s/.schema.lock", collection_directory_path);
    int lock_file_descriptor = acquire_exclusive_lock(lock_file_path);
    if (lock_file_descriptor == -1) {
        return -1;
    }
    
    FILE *schema_file_pointer = fopen(schema_file_path, "w");
    if (!schema_file_pointer) {
        fprintf(stderr, "Error creating schema file: %s\n", strerror(errno));
        release_exclusive_lock(lock_file_descriptor, lock_file_path);
        return -1;
    }
    
    for (int field_index = 0; field_index < field_count; field_index++) {
        fprintf(schema_file_pointer, "%s:%s:%s\n", 
                field_schema_array[field_index].field_name, 
                convert_field_type_to_string(field_schema_array[field_index].field_type),
                field_schema_array[field_index].field_required ? "required" : "optional");
    }
    
    fclose(schema_file_pointer);
    release_exclusive_lock(lock_file_descriptor, lock_file_path);
    
    char data_file_path[MAXIMUM_PATH_LENGTH];
    snprintf(data_file_path, MAXIMUM_PATH_LENGTH, "%s/data%s", collection_directory_path, DATA_FILE_EXTENSION);
    
    MemoryMappedFile *memory_mapped_file = open_memory_mapped_database_file(data_file_path, true);
    if (!memory_mapped_file) {
        fprintf(stderr, "Error creating data file: %s\n", strerror(errno));
        return -1;
    }
    
    close_memory_mapped_database_file(memory_mapped_file);
    
    printf("Collection '%s' created successfully in database '%s'\n", collection_name, database_name);
    return 0;
}

int check_collection_existence(const char *database_name, const char *collection_name) {
    char collection_directory_path[MAXIMUM_PATH_LENGTH];
    snprintf(collection_directory_path, MAXIMUM_PATH_LENGTH, "%s/%s/%s", 
             get_database_base_directory_path(), database_name, collection_name);
    
    struct stat directory_status;
    return (stat(collection_directory_path, &directory_status) == 0 && S_ISDIR(directory_status.st_mode));
}

char** list_collections_in_database(const char *database_name, int *collection_count_output) {
    char database_directory_path[MAXIMUM_PATH_LENGTH];
    snprintf(database_directory_path, MAXIMUM_PATH_LENGTH, "%s/%s", 
             get_database_base_directory_path(), database_name);
    
    DIR *directory_pointer = opendir(database_directory_path);
    if (!directory_pointer) {
        *collection_count_output = 0;
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
        *collection_count_output = 0;
        return NULL;
    }
    
    char **collection_names = malloc(collection_count * sizeof(char*));
    if (!collection_names) {
        closedir(directory_pointer);
        *collection_count_output = 0;
        return NULL;
    }
    
    int current_index = 0;
    while ((directory_entry = readdir(directory_pointer)) != NULL && current_index < collection_count) {
        if (directory_entry->d_type == DT_DIR && 
            strcmp(directory_entry->d_name, ".") != 0 && 
            strcmp(directory_entry->d_name, "..") != 0) {
            collection_names[current_index] = strdup(directory_entry->d_name);
            if (!collection_names[current_index]) {
                for (int cleanup_index = 0; cleanup_index < current_index; cleanup_index++) {
                    free(collection_names[cleanup_index]);
                }
                free(collection_names);
                closedir(directory_pointer);
                *collection_count_output = 0;
                return NULL;
            }
            current_index++;
        }
    }
    closedir(directory_pointer);
    
    *collection_count_output = collection_count;
    return collection_names;
}

// ==================== INSTANCE OPERATIONS ====================

char* construct_instance_json_data(char **field_names, char **field_values, int field_count) {
    char *json_data = malloc(MAXIMUM_LINE_LENGTH);
    if (!json_data) {
        return NULL;
    }
    
    strcpy(json_data, "{");
    
    for (int field_index = 0; field_index < field_count; field_index++) {
        if (field_index > 0) {
            strcat(json_data, ",");
        }
        
        if (field_values[field_index] == NULL || strlen(field_values[field_index]) == 0) {
            continue;
        }
        
        if ((field_values[field_index][0] == '[' && field_values[field_index][strlen(field_values[field_index])-1] == ']') ||
            (field_values[field_index][0] == '{' && field_values[field_index][strlen(field_values[field_index])-1] == '}')) {
            snprintf(json_data + strlen(json_data), MAXIMUM_LINE_LENGTH - strlen(json_data), 
                    "\"%s\":%s", field_names[field_index], field_values[field_index]);
        } else {
            char *validation_end_pointer;
            strtol(field_values[field_index], &validation_end_pointer, 10);
            if (*validation_end_pointer == '\0') {
                snprintf(json_data + strlen(json_data), MAXIMUM_LINE_LENGTH - strlen(json_data), 
                        "\"%s\":%s", field_names[field_index], field_values[field_index]);
            } else {
                snprintf(json_data + strlen(json_data), MAXIMUM_LINE_LENGTH - strlen(json_data), 
                        "\"%s\":\"%s\"", field_names[field_index], field_values[field_index]);
            }
        }
    }
    
    strcat(json_data, "}");
    return json_data;
}

int insert_database_instance(const char *database_name, const char *collection_name, char *instance_json_data) {
    if (!check_database_existence(database_name) || !check_collection_existence(database_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        return -1;
    }
    
    FieldSchema field_schema_array[MAXIMUM_FIELDS];
    int field_count = 0;
    if (load_collection_schema(database_name, collection_name, field_schema_array, &field_count) == -1) {
        return -1;
    }
    
    if (validate_database_instance_against_schema(instance_json_data, field_schema_array, field_count) == -1) {
        fprintf(stderr, "Instance validation failed against schema\n");
        return -1;
    }
    
    char collection_directory_path[MAXIMUM_PATH_LENGTH];
    snprintf(collection_directory_path, MAXIMUM_PATH_LENGTH, "%s/%s/%s", 
             get_database_base_directory_path(), database_name, collection_name);
    
    char lock_file_path[MAXIMUM_PATH_LENGTH];
    snprintf(lock_file_path, MAXIMUM_PATH_LENGTH, "%s/.data.lock", collection_directory_path);
    int lock_file_descriptor = acquire_exclusive_lock(lock_file_path);
    if (lock_file_descriptor == -1) {
        return -1;
    }
    
    char universally_unique_identifier[UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE];
    generate_universally_unique_identifier(universally_unique_identifier);
    
    char complete_json_data[MAXIMUM_LINE_LENGTH];
    snprintf(complete_json_data, sizeof(complete_json_data), "{\"_id\":\"%s\",\"_created_at\":%ld,%s", 
             universally_unique_identifier, time(NULL), instance_json_data + 1);
    
    char data_file_path[MAXIMUM_PATH_LENGTH];
    snprintf(data_file_path, MAXIMUM_PATH_LENGTH, "%s/data%s", collection_directory_path, DATA_FILE_EXTENSION);
    
    MemoryMappedFile *memory_mapped_file = open_memory_mapped_database_file(data_file_path, false);
    if (!memory_mapped_file) {
        memory_mapped_file = open_memory_mapped_database_file(data_file_path, true);
        if (!memory_mapped_file) {
            fprintf(stderr, "Error opening data file: %s\n", strerror(errno));
            release_exclusive_lock(lock_file_descriptor, lock_file_path);
            return -1;
        }
    }
    
    if (!append_database_record(memory_mapped_file, universally_unique_identifier, complete_json_data, strlen(complete_json_data))) {
        fprintf(stderr, "Error appending record to data file\n");
        close_memory_mapped_database_file(memory_mapped_file);
        release_exclusive_lock(lock_file_descriptor, lock_file_path);
        return -1;
    }
    
    close_memory_mapped_database_file(memory_mapped_file);
    release_exclusive_lock(lock_file_descriptor, lock_file_path);
    
    printf("Instance inserted successfully with ID: %s\n", universally_unique_identifier);
    return 0;
}

char* merge_json_objects(const char *original_json_data, const char *update_json_data) {
    char update_json_copy[MAXIMUM_LINE_LENGTH];
    strncpy(update_json_copy, update_json_data, sizeof(update_json_copy) - 1);
    update_json_copy[sizeof(update_json_copy) - 1] = '\0';
    
    if (update_json_copy[0] == '{') {
        memmove(update_json_copy, update_json_copy + 1, strlen(update_json_copy));
    }
    if (update_json_copy[strlen(update_json_copy)-1] == '}') {
        update_json_copy[strlen(update_json_copy)-1] = '\0';
    }
    
    char *update_field_names[MAXIMUM_FIELDS];
    char *update_field_values[MAXIMUM_FIELDS];
    int update_field_count = 0;
    
    char *current_token = strtok(update_json_copy, ",");
    while (current_token && update_field_count < MAXIMUM_FIELDS) {
        char *colon_position = strchr(current_token, ':');
        if (colon_position) {
            *colon_position = '\0';
            char *field_name = current_token;
            if (field_name[0] == '"') field_name++;
            if (field_name[strlen(field_name)-1] == '"') field_name[strlen(field_name)-1] = '\0';
            
            char *field_value = colon_position + 1;
            
            update_field_names[update_field_count] = strdup(field_name);
            update_field_values[update_field_count] = strdup(field_value);
            update_field_count++;
        }
        current_token = strtok(NULL, ",");
    }
    
    char *merged_json_data = malloc(MAXIMUM_LINE_LENGTH);
    if (!merged_json_data) {
        return NULL;
    }
    
    strcpy(merged_json_data, "{");
    
    char original_json_copy[MAXIMUM_LINE_LENGTH];
    strncpy(original_json_copy, original_json_data, sizeof(original_json_copy) - 1);
    original_json_copy[sizeof(original_json_copy) - 1] = '\0';
    
    if (original_json_copy[0] == '{') {
        memmove(original_json_copy, original_json_copy + 1, strlen(original_json_copy));
    }
    if (original_json_copy[strlen(original_json_copy)-1] == '}') {
        original_json_copy[strlen(original_json_copy)-1] = '\0';
    }
    
    char *original_token = strtok(original_json_copy, ",");
    int fields_added_count = 0;
    
    while (original_token) {
        char *colon_position = strchr(original_token, ':');
        if (colon_position) {
            *colon_position = '\0';
            char *field_name = original_token;
            if (field_name[0] == '"') field_name++;
            if (field_name[strlen(field_name)-1] == '"') field_name[strlen(field_name)-1] = '\0';
            
            char *field_value = colon_position + 1;
            
            bool field_updated = false;
            for (int field_index = 0; field_index < update_field_count; field_index++) {
                if (strcmp(field_name, update_field_names[field_index]) == 0) {
                    field_updated = true;
                    break;
                }
            }
            
            if (!field_updated) {
                if (fields_added_count > 0) {
                    strcat(merged_json_data, ",");
                }
                char *value_start_position = strstr(original_token, ":");
                if (value_start_position) {
                    char field_entry[512];
                    snprintf(field_entry, sizeof(field_entry), "%s%s", original_token, value_start_position);
                    strcat(merged_json_data, field_entry);
                    fields_added_count++;
                }
            }
        }
        original_token = strtok(NULL, ",");
    }
    
    for (int field_index = 0; field_index < update_field_count; field_index++) {
        if (fields_added_count > 0) {
            strcat(merged_json_data, ",");
        }
        snprintf(merged_json_data + strlen(merged_json_data), MAXIMUM_LINE_LENGTH - strlen(merged_json_data),
                "\"%s\":%s", update_field_names[field_index], update_field_values[field_index]);
        fields_added_count++;
        
        free(update_field_names[field_index]);
        free(update_field_values[field_index]);
    }
    
    strcat(merged_json_data, "}");
    return merged_json_data;
}

int update_database_instances(const char *database_name, const char *collection_name, 
                             const char *query_condition, char *update_json_data) {
    if (!check_database_existence(database_name) || !check_collection_existence(database_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        return -1;
    }
    
    FieldSchema field_schema_array[MAXIMUM_FIELDS];
    int field_count = 0;
    if (load_collection_schema(database_name, collection_name, field_schema_array, &field_count) == 0) {
        char temporary_instance_data[MAXIMUM_LINE_LENGTH];
        snprintf(temporary_instance_data, sizeof(temporary_instance_data), "{%s}", update_json_data + 1);
        if (validate_database_instance_against_schema(temporary_instance_data, field_schema_array, field_count) == -1) {
            fprintf(stderr, "Update validation failed against schema\n");
            return -1;
        }
    }
    
    char collection_directory_path[MAXIMUM_PATH_LENGTH];
    snprintf(collection_directory_path, MAXIMUM_PATH_LENGTH, "%s/%s/%s", 
             get_database_base_directory_path(), database_name, collection_name);
    
    char lock_file_path[MAXIMUM_PATH_LENGTH];
    snprintf(lock_file_path, MAXIMUM_PATH_LENGTH, "%s/.data.lock", collection_directory_path);
    int lock_file_descriptor = acquire_exclusive_lock(lock_file_path);
    if (lock_file_descriptor == -1) {
        return -1;
    }
    
    char data_file_path[MAXIMUM_PATH_LENGTH];
    snprintf(data_file_path, MAXIMUM_PATH_LENGTH, "%s/data%s", collection_directory_path, DATA_FILE_EXTENSION);
    
    MemoryMappedFile *memory_mapped_file = open_memory_mapped_database_file(data_file_path, false);
    if (!memory_mapped_file) {
        release_exclusive_lock(lock_file_descriptor, lock_file_path);
        fprintf(stderr, "Error opening data file\n");
        return -1;
    }
    
    char temporary_file_path[MAXIMUM_PATH_LENGTH];
    snprintf(temporary_file_path, MAXIMUM_PATH_LENGTH, "%s/data.tmp%s", collection_directory_path, DATA_FILE_EXTENSION);
    
    MemoryMappedFile *temporary_memory_mapped_file = open_memory_mapped_database_file(temporary_file_path, true);
    if (!temporary_memory_mapped_file) {
        close_memory_mapped_database_file(memory_mapped_file);
        release_exclusive_lock(lock_file_descriptor, lock_file_path);
        fprintf(stderr, "Error creating temporary file\n");
        return -1;
    }
    
    memcpy(temporary_memory_mapped_file->file_header_pointer, memory_mapped_file->file_header_pointer, sizeof(FileHeader));
    temporary_memory_mapped_file->file_header_pointer->total_record_count = 0;
    temporary_memory_mapped_file->file_header_pointer->next_free_offset_bytes = sizeof(FileHeader);
    
    RecordIterator *record_iterator = create_database_record_iterator(memory_mapped_file);
    int updated_instance_count = 0;
    
    RecordHeader *current_record;
    while ((current_record = retrieve_next_database_record(record_iterator)) != NULL) {
        char *record_json_data = extract_json_data_from_record(current_record);
        
        if (evaluate_json_query_condition(record_json_data, query_condition)) {
            char *merged_json_data = merge_json_objects(record_json_data, update_json_data);
            if (merged_json_data) {
                append_database_record(temporary_memory_mapped_file, current_record->record_universally_unique_identifier, merged_json_data, strlen(merged_json_data));
                free(merged_json_data);
                updated_instance_count++;
            } else {
                append_database_record(temporary_memory_mapped_file, current_record->record_universally_unique_identifier, record_json_data, strlen(record_json_data));
            }
        } else {
            append_database_record(temporary_memory_mapped_file, current_record->record_universally_unique_identifier, record_json_data, strlen(record_json_data));
        }
    }
    
    destroy_database_record_iterator(record_iterator);
    close_memory_mapped_database_file(temporary_memory_mapped_file);
    close_memory_mapped_database_file(memory_mapped_file);
    
    if (updated_instance_count > 0) {
        if (rename(temporary_file_path, data_file_path) == -1) {
            fprintf(stderr, "Error replacing data file: %s\n", strerror(errno));
            release_exclusive_lock(lock_file_descriptor, lock_file_path);
            return -1;
        }
        printf("Updated %d instance(s)\n", updated_instance_count);
    } else {
        remove(temporary_file_path);
        printf("No instances found matching query\n");
    }
    
    release_exclusive_lock(lock_file_descriptor, lock_file_path);
    return updated_instance_count > 0 ? 0 : -1;
}

int delete_database_instances(const char *database_name, const char *collection_name, const char *query_condition) {
    if (!check_database_existence(database_name) || !check_collection_existence(database_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        return -1;
    }
    
    char collection_directory_path[MAXIMUM_PATH_LENGTH];
    snprintf(collection_directory_path, MAXIMUM_PATH_LENGTH, "%s/%s/%s", 
             get_database_base_directory_path(), database_name, collection_name);
    
    char lock_file_path[MAXIMUM_PATH_LENGTH];
    snprintf(lock_file_path, MAXIMUM_PATH_LENGTH, "%s/.data.lock", collection_directory_path);
    int lock_file_descriptor = acquire_exclusive_lock(lock_file_path);
    if (lock_file_descriptor == -1) {
        return -1;
    }
    
    char data_file_path[MAXIMUM_PATH_LENGTH];
    snprintf(data_file_path, MAXIMUM_PATH_LENGTH, "%s/data%s", collection_directory_path, DATA_FILE_EXTENSION);
    
    MemoryMappedFile *memory_mapped_file = open_memory_mapped_database_file(data_file_path, false);
    if (!memory_mapped_file) {
        release_exclusive_lock(lock_file_descriptor, lock_file_path);
        fprintf(stderr, "Error opening data file\n");
        return -1;
    }
    
    char temporary_file_path[MAXIMUM_PATH_LENGTH];
    snprintf(temporary_file_path, MAXIMUM_PATH_LENGTH, "%s/data.tmp%s", collection_directory_path, DATA_FILE_EXTENSION);
    
    MemoryMappedFile *temporary_memory_mapped_file = open_memory_mapped_database_file(temporary_file_path, true);
    if (!temporary_memory_mapped_file) {
        close_memory_mapped_database_file(memory_mapped_file);
        release_exclusive_lock(lock_file_descriptor, lock_file_path);
        fprintf(stderr, "Error creating temporary file\n");
        return -1;
    }
    
    memcpy(temporary_memory_mapped_file->file_header_pointer, memory_mapped_file->file_header_pointer, sizeof(FileHeader));
    temporary_memory_mapped_file->file_header_pointer->total_record_count = 0;
    temporary_memory_mapped_file->file_header_pointer->next_free_offset_bytes = sizeof(FileHeader);
    
    RecordIterator *record_iterator = create_database_record_iterator(memory_mapped_file);
    int deleted_instance_count = 0;
    
    RecordHeader *current_record;
    while ((current_record = retrieve_next_database_record(record_iterator)) != NULL) {
        char *record_json_data = extract_json_data_from_record(current_record);
        
        if (!evaluate_json_query_condition(record_json_data, query_condition)) {
            append_database_record(temporary_memory_mapped_file, current_record->record_universally_unique_identifier, record_json_data, strlen(record_json_data));
        } else {
            deleted_instance_count++;
        }
    }
    
    destroy_database_record_iterator(record_iterator);
    close_memory_mapped_database_file(temporary_memory_mapped_file);
    close_memory_mapped_database_file(memory_mapped_file);
    
    if (deleted_instance_count > 0) {
        if (rename(temporary_file_path, data_file_path) == -1) {
            fprintf(stderr, "Error replacing data file: %s\n", strerror(errno));
            release_exclusive_lock(lock_file_descriptor, lock_file_path);
            return -1;
        }
        printf("Deleted %d instance(s)\n", deleted_instance_count);
    } else {
        remove(temporary_file_path);
        printf("No instances found matching query\n");
    }
    
    release_exclusive_lock(lock_file_descriptor, lock_file_path);
    return deleted_instance_count > 0 ? 0 : -1;
}

char** find_database_instances(const char *database_name, const char *collection_name, const char *query_condition, int *instance_count_output) {
    if (!check_database_existence(database_name) || !check_collection_existence(database_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        *instance_count_output = 0;
        return NULL;
    }
    
    char data_file_path[MAXIMUM_PATH_LENGTH];
    snprintf(data_file_path, MAXIMUM_PATH_LENGTH, "%s/%s/%s/data%s", 
             get_database_base_directory_path(), database_name, collection_name, DATA_FILE_EXTENSION);
    
    MemoryMappedFile *memory_mapped_file = open_memory_mapped_database_file(data_file_path, false);
    if (!memory_mapped_file) {
        *instance_count_output = 0;
        return NULL;
    }
    
    RecordIterator *record_iterator = create_database_record_iterator(memory_mapped_file);
    int matching_instance_count = 0;
    
    RecordHeader *current_record;
    while ((current_record = retrieve_next_database_record(record_iterator)) != NULL) {
        char *record_json_data = extract_json_data_from_record(current_record);
        if (evaluate_json_query_condition(record_json_data, query_condition)) {
            matching_instance_count++;
        }
    }
    
    destroy_database_record_iterator(record_iterator);
    
    if (matching_instance_count == 0) {
        close_memory_mapped_database_file(memory_mapped_file);
        *instance_count_output = 0;
        return NULL;
    }
    
    record_iterator = create_database_record_iterator(memory_mapped_file);
    char **query_results = malloc(matching_instance_count * sizeof(char*));
    if (!query_results) {
        destroy_database_record_iterator(record_iterator);
        close_memory_mapped_database_file(memory_mapped_file);
        *instance_count_output = 0;
        return NULL;
    }
    
    int current_index = 0;
    while ((current_record = retrieve_next_database_record(record_iterator)) != NULL && current_index < matching_instance_count) {
        char *record_json_data = extract_json_data_from_record(current_record);
        if (evaluate_json_query_condition(record_json_data, query_condition)) {
            query_results[current_index] = strdup(record_json_data);
            if (!query_results[current_index]) {
                for (int cleanup_index = 0; cleanup_index < current_index; cleanup_index++) {
                    free(query_results[cleanup_index]);
                }
                free(query_results);
                destroy_database_record_iterator(record_iterator);
                close_memory_mapped_database_file(memory_mapped_file);
                *instance_count_output = 0;
                return NULL;
            }
            current_index++;
        }
    }
    
    destroy_database_record_iterator(record_iterator);
    close_memory_mapped_database_file(memory_mapped_file);
    
    *instance_count_output = current_index;
    return query_results;
}

char** list_all_collection_instances(const char *database_name, const char *collection_name, int *instance_count_output) {
    char data_file_path[MAXIMUM_PATH_LENGTH];
    snprintf(data_file_path, MAXIMUM_PATH_LENGTH, "%s/%s/%s/data%s", 
             get_database_base_directory_path(), database_name, collection_name, DATA_FILE_EXTENSION);
    
    MemoryMappedFile *memory_mapped_file = open_memory_mapped_database_file(data_file_path, false);
    if (!memory_mapped_file) {
        *instance_count_output = 0;
        return NULL;
    }
    
    int total_instance_count = memory_mapped_file->file_header_pointer->total_record_count;
    
    if (total_instance_count == 0) {
        close_memory_mapped_database_file(memory_mapped_file);
        *instance_count_output = 0;
        return NULL;
    }
    
    char **instance_list = malloc(total_instance_count * sizeof(char*));
    if (!instance_list) {
        close_memory_mapped_database_file(memory_mapped_file);
        *instance_count_output = 0;
        return NULL;
    }
    
    RecordIterator *record_iterator = create_database_record_iterator(memory_mapped_file);
    int current_index = 0;
    
    RecordHeader *current_record;
    while ((current_record = retrieve_next_database_record(record_iterator)) != NULL && current_index < total_instance_count) {
        char *record_json_data = extract_json_data_from_record(current_record);
        instance_list[current_index] = strdup(record_json_data);
        if (!instance_list[current_index]) {
            for (int cleanup_index = 0; cleanup_index < current_index; cleanup_index++) {
                free(instance_list[cleanup_index]);
            }
            free(instance_list);
            destroy_database_record_iterator(record_iterator);
            close_memory_mapped_database_file(memory_mapped_file);
            *instance_count_output = 0;
            return NULL;
        }
        current_index++;
    }
    
    destroy_database_record_iterator(record_iterator);
    close_memory_mapped_database_file(memory_mapped_file);
    
    *instance_count_output = current_index;
    return instance_list;
}

// ==================== COMMAND LINE INTERFACE ====================

void display_usage_information() {
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

int parse_insert_field_data(int argument_count, char *argument_array[], int starting_index, 
                           char **field_names, char **field_values, int *field_count_output) {
    *field_count_output = 0;
    
    for (int argument_index = starting_index; 
         argument_index < argument_count && *field_count_output < MAXIMUM_FIELDS; 
         argument_index++) {
        char *field_specification = argument_array[argument_index];
        if (strncmp(field_specification, "--", 2) != 0) {
            continue;
        }
        
        field_specification += 2;
        
        char *value_separator = strchr(field_specification, '-');
        if (!value_separator) {
            continue;
        }
        
        *value_separator = '\0';
        char *field_value = value_separator + 1;
        
        if (strlen(field_value) == 0) {
            field_names[*field_count_output] = strdup(field_specification);
            field_values[*field_count_output] = strdup("");
        } else {
            if (field_value[0] == '"' && field_value[strlen(field_value)-1] == '"') {
                field_value[strlen(field_value)-1] = '\0';
                field_value++;
            }
            
            field_names[*field_count_output] = strdup(field_specification);
            field_values[*field_count_output] = strdup(field_value);
        }
        
        if (!field_names[*field_count_output] || !field_values[*field_count_output]) {
            for (int cleanup_index = 0; cleanup_index < *field_count_output; cleanup_index++) {
                free(field_names[cleanup_index]);
                free(field_values[cleanup_index]);
            }
            return -1;
        }
        
        (*field_count_output)++;
    }
    
    return 0;
}

int main(int argument_count, char *argument_array[]) {
    if (argument_count < 2) {
        display_usage_information();
        return 1;
    }
    
    ensure_directory_exists(get_database_base_directory_path());
    
    if (strcmp(argument_array[1], "create") == 0) {
        if (argument_count < 3) {
            fprintf(stderr, "Error: Missing database name\n");
            display_usage_information();
            return 1;
        }
        
        if (argument_count == 3) {
            return create_database(argument_array[2]);
        }
        else if (argument_count >= 5) {
            int schema_flag_index = -1;
            int insert_flag_index = -1;
            
            for (int argument_index = 3; argument_index < argument_count; argument_index++) {
                if (strcmp(argument_array[argument_index], "--schema") == 0) {
                    schema_flag_index = argument_index;
                    break;
                } else if (strcmp(argument_array[argument_index], "--insert-one") == 0) {
                    insert_flag_index = argument_index;
                    break;
                }
            }
            
            if (schema_flag_index != -1) {
                if (schema_flag_index != 4) {
                    fprintf(stderr, "Error: Invalid syntax. Use: sydb create <db> <collection> --schema ...\n");
                    display_usage_information();
                    return 1;
                }
                
                if (argument_count < 6) {
                    fprintf(stderr, "Error: Missing schema fields\n");
                    display_usage_information();
                    return 1;
                }
                
                FieldSchema field_schema_array[MAXIMUM_FIELDS];
                int field_count = 0;
                if (parse_schema_field_definitions(argument_count, argument_array, schema_flag_index + 1, 
                                           field_schema_array, &field_count) == -1) {
                    return 1;
                }
                
                if (field_count == 0) {
                    fprintf(stderr, "Error: No valid schema fields provided\n");
                    return 1;
                }
                
                return create_collection(argument_array[2], argument_array[3], field_schema_array, field_count);
            }
            else if (insert_flag_index != -1) {
                if (insert_flag_index != 4) {
                    fprintf(stderr, "Error: Invalid syntax. Use: sydb create <db> <collection> --insert-one ...\n");
                    display_usage_information();
                    return 1;
                }
                
                if (argument_count < 6) {
                    fprintf(stderr, "Error: Missing insert data\n");
                    display_usage_information();
                    return 1;
                }
                
                char *field_names[MAXIMUM_FIELDS];
                char *field_values[MAXIMUM_FIELDS];
                int field_count = 0;
                
                if (parse_insert_field_data(argument_count, argument_array, insert_flag_index + 1, 
                                    field_names, field_values, &field_count) == -1) {
                    fprintf(stderr, "Error: Failed to parse insert data\n");
                    return 1;
                }
                
                if (field_count == 0) {
                    fprintf(stderr, "Error: No valid insert fields provided\n");
                    return 1;
                }
                
                char *instance_json_data = construct_instance_json_data(field_names, field_values, field_count);
                if (!instance_json_data) {
                    fprintf(stderr, "Error: Failed to build instance JSON\n");
                    for (int cleanup_index = 0; cleanup_index < field_count; cleanup_index++) {
                        free(field_names[cleanup_index]);
                        free(field_values[cleanup_index]);
                    }
                    return 1;
                }
                
                int operation_result = insert_database_instance(argument_array[2], argument_array[3], instance_json_data);
                
                free(instance_json_data);
                for (int cleanup_index = 0; cleanup_index < field_count; cleanup_index++) {
                    free(field_names[cleanup_index]);
                    free(field_values[cleanup_index]);
                }
                
                return operation_result;
            }
            else {
                fprintf(stderr, "Error: Missing --schema or --insert-one flag\n");
                display_usage_information();
                return 1;
            }
        }
        else {
            fprintf(stderr, "Error: Invalid create operation\n");
            display_usage_information();
            return 1;
        }
    }
    else if (strcmp(argument_array[1], "update") == 0) {
        if (argument_count < 7 || strcmp(argument_array[4], "--where") != 0 || 
            strcmp(argument_array[6], "--set") != 0) {
            fprintf(stderr, "Error: Invalid update syntax\n");
            display_usage_information();
            return 1;
        }
        
        char *field_names[MAXIMUM_FIELDS];
        char *field_values[MAXIMUM_FIELDS];
        int field_count = 0;
        
        if (parse_insert_field_data(argument_count, argument_array, 7, field_names, field_values, &field_count) == -1) {
            fprintf(stderr, "Error: Failed to parse update data\n");
            return 1;
        }
        
        if (field_count == 0) {
            fprintf(stderr, "Error: No valid update fields provided\n");
            return 1;
        }
        
        char *update_json_data = construct_instance_json_data(field_names, field_values, field_count);
        if (!update_json_data) {
            fprintf(stderr, "Error: Failed to build update JSON\n");
            for (int cleanup_index = 0; cleanup_index < field_count; cleanup_index++) {
                free(field_names[cleanup_index]);
                free(field_values[cleanup_index]);
            }
            return 1;
        }
        
        int operation_result = update_database_instances(argument_array[2], argument_array[3], argument_array[5], update_json_data);
        
        free(update_json_data);
        for (int cleanup_index = 0; cleanup_index < field_count; cleanup_index++) {
            free(field_names[cleanup_index]);
            free(field_values[cleanup_index]);
        }
        
        return operation_result;
    }
    else if (strcmp(argument_array[1], "delete") == 0) {
        if (argument_count < 6 || strcmp(argument_array[4], "--where") != 0) {
            fprintf(stderr, "Error: Invalid delete syntax\n");
            display_usage_information();
            return 1;
        }
        
        return delete_database_instances(argument_array[2], argument_array[3], argument_array[5]);
    }
    else if (strcmp(argument_array[1], "find") == 0) {
        if (argument_count < 6 || strcmp(argument_array[4], "--where") != 0) {
            fprintf(stderr, "Error: Invalid find syntax\n");
            display_usage_information();
            return 1;
        }
        
        int result_count;
        char **query_results = find_database_instances(argument_array[2], argument_array[3], argument_array[5], &result_count);
        if (result_count > 0) {
            for (int result_index = 0; result_index < result_count; result_index++) {
                printf("%s\n", query_results[result_index]);
                free(query_results[result_index]);
            }
            free(query_results);
            return 0;
        } else {
            printf("No instances found\n");
            return 1;
        }
    }
    else if (strcmp(argument_array[1], "schema") == 0) {
        if (argument_count < 4) {
            fprintf(stderr, "Error: Missing database or collection name\n");
            display_usage_information();
            return 1;
        }
        
        display_collection_schema(argument_array[2], argument_array[3]);
        return 0;
    }
    else if (strcmp(argument_array[1], "list") == 0) {
        if (argument_count == 2) {
            int database_count;
            char **database_list = list_all_databases(&database_count);
            if (database_count == 0) {
                printf("No databases found\n");
            } else {
                printf("Databases:\n");
                for (int database_index = 0; database_index < database_count; database_index++) {
                    printf("  %s\n", database_list[database_index]);
                    free(database_list[database_index]);
                }
                free(database_list);
            }
            return 0;
        }
        else if (argument_count == 3) {
            int collection_count;
            char **collection_list = list_collections_in_database(argument_array[2], &collection_count);
            if (collection_count == 0) {
                printf("No collections found in database '%s'\n", argument_array[2]);
            } else {
                printf("Collections in database '%s':\n", argument_array[2]);
                for (int collection_index = 0; collection_index < collection_count; collection_index++) {
                    printf("  %s\n", collection_list[collection_index]);
                    free(collection_list[collection_index]);
                }
                free(collection_list);
            }
            return 0;
        }
        else if (argument_count == 4) {
            int instance_count;
            char **instance_list = list_all_collection_instances(argument_array[2], argument_array[3], &instance_count);
            if (instance_count == 0) {
                printf("No instances found in collection '%s'\n", argument_array[3]);
            } else {
                printf("Instances in collection '%s':\n", argument_array[3]);
                for (int instance_index = 0; instance_index < instance_count; instance_index++) {
                    printf("  %s\n", instance_list[instance_index]);
                    free(instance_list[instance_index]);
                }
                free(instance_list);
            }
            return 0;
        }
        else {
            fprintf(stderr, "Error: Invalid list operation\n");
            display_usage_information();
            return 1;
        }
    }
    else {
        fprintf(stderr, "Error: Unknown command '%s'\n", argument_array[1]);
        display_usage_information();
        return 1;
    }
    
    return 0;
}
