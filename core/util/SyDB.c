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
#include <pthread.h>
#include <math.h>
#include <limits.h>
#include <regex.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <signal.h>

// ==================== CONSTANTS AND CONFIGURATION ====================

#define MAXIMUM_NAME_LENGTH 256
#define MAXIMUM_FIELD_LENGTH 64
#define MAXIMUM_FIELDS 128
#define MAXIMUM_PATH_LENGTH 1024
#define MAXIMUM_LINE_LENGTH 4096
#define UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE 37
#define SYDB_BASE_DIRECTORY "/var/lib/sydb"
#define LOCK_TIMEOUT_SECONDS 30
#define DATA_FILE_EXTENSION ".sydb"
#define INDEX_FILE_EXTENSION ".sydidx"
#define FILE_MAGIC_NUMBER 0x53594442
#define FILE_VERSION_NUMBER 2
#define CACHE_CAPACITY 10000
#define B_TREE_ORDER 16
#define MAXIMUM_CONCURRENT_READERS 100
#define MAXIMUM_THREAD_POOL_SIZE 16
#define BATCH_BUFFER_SIZE (1024 * 1024)
#define MAXIMUM_INDEXES_PER_COLLECTION 32
#define QUERY_RESULT_BUFFER_SIZE 1000
#define HTTP_SERVER_MAX_CONNECTIONS 1000
#define HTTP_SERVER_PORT 8080
#define HTTP_SERVER_BUFFER_SIZE 8192
#define HTTP_SERVER_MAX_HEADERS 100
#define HTTP_SERVER_MAX_CONTENT_LENGTH (10 * 1024 * 1024) // 10MB

typedef enum {
    FIELD_TYPE_STRING,
    FIELD_TYPE_INTEGER,
    FIELD_TYPE_FLOAT,
    FIELD_TYPE_BOOLEAN,
    FIELD_TYPE_ARRAY,
    FIELD_TYPE_OBJECT,
    FIELD_TYPE_NULL
} field_type_t;

//----
char* string_repeat(char c, int count);
void display_http_routes();
// ==================== HTTP SERVER STRUCTURES ====================

typedef struct {
    char method[16];
    char path[1024];
    char version[16];
    char* headers[HTTP_SERVER_MAX_HEADERS];
    int header_count;
    char* body;
    size_t body_length;
    char* query_string;
} http_request_t;

typedef struct {
    int status_code;
    char* status_message;
    char* headers[HTTP_SERVER_MAX_HEADERS];
    int header_count;
    char* body;
    size_t body_length;
} http_response_t;

typedef struct {
    int client_socket;
    struct sockaddr_in client_address;
    http_request_t request;
    http_response_t response;
} http_client_context_t;

typedef struct {
    int server_socket;
    int port;
    bool running;
    pthread_t accept_thread;
    pthread_t worker_threads[MAXIMUM_THREAD_POOL_SIZE];
    pthread_mutex_t queue_mutex;
    pthread_cond_t queue_condition;
    http_client_context_t* client_queue[HTTP_SERVER_MAX_CONNECTIONS];
    int queue_size;
    int queue_front;
    int queue_rear;
} http_server_t;

// ==================== HTTP ROUTES DOCUMENTATION ====================

typedef struct {
    char method[16];
    char path[256];
    char description[512];
    char request_schema[1024];
    char response_schema[1024];
} http_route_info_t;

// Global routes array
http_route_info_t http_routes[] = {
    {
        "GET",
        "/api/databases",
        "List all databases in the system",
        "No request body required",
        "{\n  \"databases\": [\"db1\", \"db2\", ...]\n}"
    },
    {
        "GET", 
        "/api/databases/{database_name}/collections",
        "List all collections in a specific database",
        "No request body required",
        "{\n  \"collections\": [\"collection1\", \"collection2\", ...]\n}"
    },
    {
        "GET",
        "/api/databases/{database_name}/collections/{collection_name}/instances",
        "List all instances in a collection",
        "No request body required", 
        "[\n  {\n    \"_id\": \"uuid\",\n    \"_created_at\": timestamp,\n    \"field1\": \"value1\",\n    ...\n  }\n]"
    },
    {
        "POST",
        "/api/execute",
        "Execute SYDB commands via HTTP",
        "{\n  \"command\": \"sydb command string\",\n  \"arguments\": [\"arg1\", \"arg2\", ...]\n}",
        "{\n  \"success\": true|false,\n  \"result\": \"command output or data\",\n  \"error\": \"error message if any\"\n}"
    },
    {
        "POST",
        "/api/databases/{database_name}/collections/{collection_name}/instances",
        "Insert a new instance into a collection",
        "{\n  \"field1\": \"value1\",\n  \"field2\": \"value2\",\n  ...\n}",
        "{\n  \"success\": true|false,\n  \"id\": \"generated_uuid\",\n  \"message\": \"Instance created successfully\"\n}"
    },
    {
        "GET",
        "/api/databases/{database_name}/collections/{collection_name}/schema",
        "Get the schema of a collection",
        "No request body required",
        "{\n  \"fields\": [\n    {\n      \"name\": \"field_name\",\n      \"type\": \"string|int|float|bool|array|object\",\n      \"required\": true|false,\n      \"indexed\": true|false\n    }\n  ]\n}"
    }
};

#define HTTP_ROUTES_COUNT (sizeof(http_routes) / sizeof(http_route_info_t))

// ==================== HIGH-PERFORMANCE DATA STRUCTURES ====================

typedef struct {
    char name[MAXIMUM_FIELD_LENGTH];
    field_type_t type;
    bool required;
    bool indexed;
} field_schema_t;

typedef struct {
    char universally_unique_identifier[UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE];
    uint8_t* binary_data;
    size_t data_length;
    uint64_t file_offset;
    time_t timestamp;
} database_instance_t;

typedef struct binary_field_header {
    uint16_t field_identifier;
    field_type_t type;
    uint16_t data_length;
    uint8_t data[];
} binary_field_header_t;

typedef struct {
    uint32_t magic_number;
    uint32_t version_number;
    uint64_t record_count;
    uint64_t file_size;
    uint64_t free_offset;
    uint32_t schema_checksum;
    uint64_t index_root_offset;
    uint32_t flags;
    uint8_t reserved[84];
} file_header_t;

typedef struct {
    uint64_t data_size;
    uint64_t timestamp;
    uint32_t flags;
    uint32_t data_checksum;
    uint32_t field_count;
    char universally_unique_identifier[UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE];
    uint8_t reserved[20];
} record_header_t;

// ==================== B-TREE INDEX IMPLEMENTATION ====================

typedef struct b_tree_node {
    uint64_t record_offsets[B_TREE_ORDER - 1];
    char keys[B_TREE_ORDER - 1][MAXIMUM_FIELD_LENGTH];
    uint64_t child_node_offsets[B_TREE_ORDER];
    uint32_t key_count;
    bool is_leaf;
    uint64_t node_offset;
} b_tree_node_t;

typedef struct {
    char field_name[MAXIMUM_FIELD_LENGTH];
    field_type_t field_type;
    b_tree_node_t* root_node;
    uint64_t root_node_offset;
    pthread_rwlock_t lock;
} field_index_t;

void display_http_routes() {
    printf("SYDB HTTP Server Available Routes:\n");
    printf("===================================\n\n");
    
    for (size_t i = 0; i < HTTP_ROUTES_COUNT; i++) {
        printf("Method: %s\n", http_routes[i].method);
        printf("Path: %s\n", http_routes[i].path);
        printf("Description: %s\n", http_routes[i].description);
        printf("Request Schema:\n%s\n", http_routes[i].request_schema);
        printf("Response Schema:\n%s\n", http_routes[i].response_schema);
        printf("%s\n", string_repeat('-', 60));
    }
    
    printf("\nUsage Examples:\n");
    printf("1. List all databases:\n");
    printf("   curl -X GET http://localhost:8080/api/databases\n\n");
    
    printf("2. Create a new instance:\n");
    printf("   curl -X POST http://localhost:8080/api/execute \\\n");
    printf("     -H \"Content-Type: application/json\" \\\n");
    printf("     -d '{\"command\": \"create mydb users --insert-one --name-\\\"John\\\" --age-25\"}'\n\n");
    
    printf("3. Find instances with query:\n");
    printf("   curl -X POST http://localhost:8080/api/execute \\\n");
    printf("     -H \"Content-Type: application/json\" \\\n");
    printf("     -d '{\"command\": \"find mydb users --where \\\"name:John\\\"\"}'\n");
}

// Helper function to repeat a character
char* string_repeat(char c, int count) {
    static char buffer[128];
    if (count > 127) count = 127;
    memset(buffer, c, count);
    buffer[count] = '\0';
    return buffer;
}

// ==================== CACHE IMPLEMENTATION ====================

typedef struct cache_entry {
    char universally_unique_identifier[UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE];
    database_instance_t* instance;
    time_t last_accessed_time;
    uint64_t access_count;
    struct cache_entry* next_entry;
    struct cache_entry* previous_entry;
} cache_entry_t;

typedef struct {
    cache_entry_t** entries;
    cache_entry_t* head_entry;
    cache_entry_t* tail_entry;
    size_t capacity;
    size_t size;
    uint64_t cache_hits;
    uint64_t cache_misses;
    pthread_rwlock_t lock;
} lru_cache_t;

// ==================== CONCURRENCY CONTROL ====================

typedef struct {
    pthread_rwlock_t schema_lock;
    pthread_rwlock_t data_lock;
    pthread_mutex_t cache_lock;
    pthread_rwlock_t index_lock;
    pthread_cond_t write_complete_condition;
    int active_readers_count;
    int waiting_writers_count;
    bool writer_active;
} collection_lock_t;

typedef struct {
    pthread_t threads[MAXIMUM_THREAD_POOL_SIZE];
    pthread_mutex_t queue_lock;
    pthread_cond_t queue_condition;
    void (*tasks[MAXIMUM_THREAD_POOL_SIZE])(void*);
    void* task_arguments[MAXIMUM_THREAD_POOL_SIZE];
    int task_count;
    int active_threads_count;
    bool shutdown;
} thread_pool_t;

// ==================== DATABASE COLLECTION STRUCTURE ====================

typedef struct {
    char database_name[MAXIMUM_NAME_LENGTH];
    char collection_name[MAXIMUM_NAME_LENGTH];
    field_schema_t fields[MAXIMUM_FIELDS];
    int field_count;
    field_index_t indexes[MAXIMUM_INDEXES_PER_COLLECTION];
    int index_count;
    lru_cache_t* cache;
    collection_lock_t locks;
    FILE* data_file;
    FILE* index_file;
    bool initialized;
} database_collection_t;

// ==================== RECORD ITERATOR FOR HIGH-PERFORMANCE SCANNING ====================

typedef struct {
    FILE* data_file;
    uint64_t current_offset;
    uint64_t records_processed;
    lru_cache_t* cache;
} record_iterator_t;

// ==================== FUNCTION DECLARATIONS ====================

// Core JSON functions
char* json_get_string_value(const char* json_data, const char* key);
int json_get_integer_value(const char* json_data, const char* key);
bool json_has_field(const char* json_data, const char* key);
bool json_matches_query_conditions(const char* json_data, const char* query);

// Security validation functions
bool validate_path_component(const char* component);
bool validate_database_name(const char* database_name);
bool validate_collection_name(const char* collection_name);
bool validate_field_name(const char* field_name);
void* secure_malloc(size_t size);
void secure_free(void** ptr);

// Utility functions
void generate_secure_universally_unique_identifier(char* universally_unique_identifier);
int create_secure_directory_recursively(const char* path);
uint32_t compute_crc_32_checksum(const void* data, size_t length);
char* get_secure_sydb_base_directory_path();
int acquire_secure_exclusive_lock(const char* lock_file_path);
void release_secure_exclusive_lock(int file_descriptor, const char* lock_file_path);

// Cache functions
lru_cache_t* create_secure_lru_cache(size_t capacity);
void destroy_secure_lru_cache(lru_cache_t* cache);
void lru_cache_put_secure(lru_cache_t* cache, const char* universally_unique_identifier, database_instance_t* instance);
database_instance_t* lru_cache_get_secure(lru_cache_t* cache, const char* universally_unique_identifier);

// B-tree functions
b_tree_node_t* create_secure_b_tree_node(bool is_leaf_node);
int b_tree_search_node_secure(b_tree_node_t* node, const char* search_key, uint64_t* record_offset);
void b_tree_insert_non_full_node_secure(b_tree_node_t* node, const char* key, uint64_t record_offset);
void b_tree_insert_into_index_secure(field_index_t* index, const char* key, uint64_t record_offset);

// File operations
FILE* open_secure_data_file_with_optimizations(const char* database_name, const char* collection_name, const char* mode);
int initialize_secure_high_performance_data_file(FILE* data_file);
int read_secure_file_header_information(FILE* data_file, file_header_t* file_header);
int write_secure_file_header_information(FILE* data_file, file_header_t* file_header);

// Concurrency control
int initialize_secure_collection_locks(collection_lock_t* locks);
void acquire_secure_collection_read_lock(collection_lock_t* locks);
void release_secure_collection_read_lock(collection_lock_t* locks);
void acquire_secure_collection_write_lock(collection_lock_t* locks);
void release_secure_collection_write_lock(collection_lock_t* locks);

// Schema management
field_type_t parse_secure_field_type_from_string(const char* type_string);
const char* convert_secure_field_type_to_string(field_type_t type);
int parse_secure_schema_fields_from_arguments(int argument_count, char* argument_values[], int start_index, 
                                             field_schema_t* fields, int* field_count);
int load_secure_schema_from_file(const char* database_name, const char* collection_name, 
                                field_schema_t* fields, int* field_count);
bool validate_secure_field_value_against_schema(const char* field_name, const char* value, field_type_t type);
int validate_secure_instance_against_schema(const char* instance_json, 
                                           field_schema_t* fields, int field_count);
void print_secure_collection_schema(const char* database_name, const char* collection_name);

// Database operations
int database_secure_exists(const char* database_name);
int collection_secure_exists(const char* database_name, const char* collection_name);
int create_secure_database(const char* database_name);
char** list_all_secure_databases(int* database_count);

// Collection operations
int create_secure_collection(const char* database_name, const char* collection_name, 
                            field_schema_t* fields, int field_count);
char** list_secure_collections_in_database(const char* database_name, int* collection_count);

// Instance operations
char* build_secure_instance_json_from_fields_and_values(char** field_names, char** field_values, int field_count);
int insert_secure_instance_into_collection(const char* database_name, const char* collection_name, char* instance_json);

// Record iterator functions
record_iterator_t* create_secure_record_iterator(FILE* data_file, lru_cache_t* cache);
void free_secure_record_iterator(record_iterator_t* iterator);
int read_secure_next_record_from_iterator(record_iterator_t* iterator, record_header_t* record_header, char** json_data);

// Query operations
char** find_secure_instances_with_query(const char* database_name, const char* collection_name, const char* query, int* result_count);
char** list_all_secure_instances_in_collection(const char* database_name, const char* collection_name, int* instance_count);

// Command line interface
void print_secure_usage_information();
int parse_secure_insert_data_from_arguments(int argument_count, char* argument_values[], int start_index, 
                                           char** field_names, char** field_values, int* field_count);

// HTTP Server functions
void http_server_initialize_response(http_response_t* response);
void http_server_initialize_request(http_request_t* request);
void http_server_free_request(http_request_t* request);
void http_server_free_response(http_response_t* response);
int http_response_add_header(http_response_t* response, const char* name, const char* value);
int http_response_set_body(http_response_t* response, const char* body, size_t length);
int http_response_set_json_body(http_response_t* response, const char* json_body);
int http_parse_request(const char* request_data, size_t request_length, http_request_t* request);
int http_send_response(int client_socket, http_response_t* response);
void* http_client_handler(void* arg);
void* http_accept_loop(void* arg);
int http_server_start(int port);
void http_server_stop();
void http_server_handle_signal(int signal);

// ==================== SECURITY VALIDATION FUNCTIONS ====================

bool validate_path_component(const char* component) {
    if (!component || strlen(component) == 0) return false;
    if (strlen(component) >= MAXIMUM_NAME_LENGTH) return false;
    
    if (strchr(component, '/') != NULL) return false;
    if (strchr(component, '\\') != NULL) return false;
    if (strcmp(component, ".") == 0) return false;
    if (strcmp(component, "..") == 0) return false;
    
    for (size_t i = 0; i < strlen(component); i++) {
        if (component[i] < 32 || component[i] == 127) return false;
    }
    
    return true;
}

bool validate_database_name(const char* database_name) {
    return validate_path_component(database_name);
}

bool validate_collection_name(const char* collection_name) {
    return validate_path_component(collection_name);
}

bool validate_field_name(const char* field_name) {
    if (!field_name || strlen(field_name) == 0) return false;
    if (strlen(field_name) >= MAXIMUM_FIELD_LENGTH) return false;
    
    for (size_t i = 0; i < strlen(field_name); i++) {
        char c = field_name[i];
        if (!((c >= 'a' && c <= 'z') || 
              (c >= 'A' && c <= 'Z') || 
              (c >= '0' && c <= '9') || 
              c == '_')) {
            return false;
        }
    }
    
    return true;
}

void* secure_malloc(size_t size) {
    if (size == 0 || size > SIZE_MAX / 2) {
        return NULL;
    }
    
    void* ptr = malloc(size);
    if (ptr) {
        memset(ptr, 0, size);
    }
    return ptr;
}

void secure_free(void** ptr) {
    if (ptr && *ptr) {
        free(*ptr);
        *ptr = NULL;
    }
}

// ==================== HTTP SERVER IMPLEMENTATION ====================

http_server_t* http_server_instance = NULL;

void http_server_initialize_response(http_response_t* response) {
    if (!response) return;
    
    response->status_code = 200;
    response->status_message = "OK";
    response->header_count = 0;
    response->body = NULL;
    response->body_length = 0;
    
    // Set default headers
    http_response_add_header(response, "Server", "SYDB-HTTP-Server/1.0");
    http_response_add_header(response, "Connection", "close");
}

void http_server_initialize_request(http_request_t* request) {
    if (!request) return;
    
    memset(request->method, 0, sizeof(request->method));
    memset(request->path, 0, sizeof(request->path));
    memset(request->version, 0, sizeof(request->version));
    request->header_count = 0;
    request->body = NULL;
    request->body_length = 0;
    request->query_string = NULL;
    
    for (int i = 0; i < HTTP_SERVER_MAX_HEADERS; i++) {
        request->headers[i] = NULL;
    }
}

void http_server_free_request(http_request_t* request) {
    if (!request) return;
    
    for (int i = 0; i < request->header_count; i++) {
        if (request->headers[i]) {
            free(request->headers[i]);
        }
    }
    
    if (request->body) {
        free(request->body);
    }
    
    if (request->query_string) {
        free(request->query_string);
    }
}

void http_server_free_response(http_response_t* response) {
    if (!response) return;
    
    for (int i = 0; i < response->header_count; i++) {
        if (response->headers[i]) {
            free(response->headers[i]);
        }
    }
    
    if (response->body) {
        free(response->body);
    }
}

int http_response_add_header(http_response_t* response, const char* name, const char* value) {
    if (!response || !name || !value || response->header_count >= HTTP_SERVER_MAX_HEADERS) {
        return -1;
    }
    
    size_t header_length = strlen(name) + strlen(value) + 3; // name: value\0
    char* header = malloc(header_length);
    if (!header) return -1;
    
    snprintf(header, header_length, "%s: %s", name, value);
    response->headers[response->header_count++] = header;
    return 0;
}

int http_response_set_body(http_response_t* response, const char* body, size_t length) {
    if (!response || !body) return -1;
    
    if (response->body) {
        free(response->body);
    }
    
    response->body = malloc(length + 1);
    if (!response->body) return -1;
    
    memcpy(response->body, body, length);
    response->body[length] = '\0';
    response->body_length = length;
    
    char content_length[32];
    snprintf(content_length, sizeof(content_length), "%zu", length);
    http_response_add_header(response, "Content-Length", content_length);
    
    return 0;
}

int http_response_set_json_body(http_response_t* response, const char* json_body) {
    if (!response || !json_body) return -1;
    
    http_response_set_body(response, json_body, strlen(json_body));
    http_response_add_header(response, "Content-Type", "application/json");
    return 0;
}

int http_parse_request(const char* request_data, size_t request_length, http_request_t* request) {
    if (!request_data || !request || request_length == 0) return -1;
    
    http_server_initialize_request(request);
    
    // Parse request line
    const char* line_start = request_data;
    const char* line_end = strstr(line_start, "\r\n");
    if (!line_end) return -1;
    
    // Parse method, path, version
    char request_line[1024];
    size_t line_length = line_end - line_start;
    if (line_length >= sizeof(request_line)) return -1;
    
    memcpy(request_line, line_start, line_length);
    request_line[line_length] = '\0';
    
    char* saveptr = NULL;
    char* token = strtok_r(request_line, " ", &saveptr);
    if (!token) return -1;
    strncpy(request->method, token, sizeof(request->method) - 1);
    
    token = strtok_r(NULL, " ", &saveptr);
    if (!token) return -1;
    
    // Parse path and query string
    char* query_start = strchr(token, '?');
    if (query_start) {
        *query_start = '\0';
        request->query_string = strdup(query_start + 1);
        strncpy(request->path, token, sizeof(request->path) - 1);
    } else {
        strncpy(request->path, token, sizeof(request->path) - 1);
    }
    
    token = strtok_r(NULL, " ", &saveptr);
    if (!token) return -1;
    strncpy(request->version, token, sizeof(request->version) - 1);
    
    // Parse headers
    line_start = line_end + 2;
    while (line_start < request_data + request_length) {
        line_end = strstr(line_start, "\r\n");
        if (!line_end) break;
        
        if (line_end == line_start) {
            // Empty line indicates end of headers
            line_start = line_end + 2;
            break;
        }
        
        line_length = line_end - line_start;
        if (line_length > 0 && request->header_count < HTTP_SERVER_MAX_HEADERS) {
            request->headers[request->header_count] = malloc(line_length + 1);
            if (request->headers[request->header_count]) {
                memcpy(request->headers[request->header_count], line_start, line_length);
                request->headers[request->header_count][line_length] = '\0';
                request->header_count++;
            }
        }
        
        line_start = line_end + 2;
    }
    
    // Parse body
    if (line_start < request_data + request_length) {
        size_t body_length = (request_data + request_length) - line_start;
        if (body_length > 0 && body_length <= HTTP_SERVER_MAX_CONTENT_LENGTH) {
            request->body = malloc(body_length + 1);
            if (request->body) {
                memcpy(request->body, line_start, body_length);
                request->body[body_length] = '\0';
                request->body_length = body_length;
            }
        }
    }
    
    return 0;
}

int http_send_response(int client_socket, http_response_t* response) {
    if (client_socket < 0 || !response) return -1;
    
    // Build response
    char status_line[256];
    snprintf(status_line, sizeof(status_line), "HTTP/1.1 %d %s\r\n", 
             response->status_code, response->status_message);
    
    // Send status line
    if (send(client_socket, status_line, strlen(status_line), 0) < 0) {
        return -1;
    }
    
    // Send headers
    for (int i = 0; i < response->header_count; i++) {
        if (response->headers[i]) {
            char header_line[1024];
            snprintf(header_line, sizeof(header_line), "%s\r\n", response->headers[i]);
            if (send(client_socket, header_line, strlen(header_line), 0) < 0) {
                return -1;
            }
        }
    }
    
    // End of headers
    if (send(client_socket, "\r\n", 2, 0) < 0) {
        return -1;
    }
    
    // Send body
    if (response->body && response->body_length > 0) {
        if (send(client_socket, response->body, response->body_length, 0) < 0) {
            return -1;
        }
    }
    
    return 0;
}

void* http_client_handler(void* arg) {
    http_client_context_t* context = (http_client_context_t*)arg;
    if (!context) return NULL;
    
    http_server_initialize_response(&context->response);
    
    // Route the request based on path and method
    if (strcmp(context->request.method, "GET") == 0) {
        if (strncmp(context->request.path, "/api/databases", 14) == 0) {
            // List databases or specific database
            if (strcmp(context->request.path, "/api/databases") == 0) {
                int database_count;
                char** databases = list_all_secure_databases(&database_count);
                
                if (database_count > 0) {
                    char json_buffer[HTTP_SERVER_BUFFER_SIZE];
                    snprintf(json_buffer, sizeof(json_buffer), "{\"databases\":[");
                    
                    for (int i = 0; i < database_count; i++) {
                        strcat(json_buffer, "\"");
                        strcat(json_buffer, databases[i]);
                        strcat(json_buffer, "\"");
                        if (i < database_count - 1) strcat(json_buffer, ",");
                        free(databases[i]);
                    }
                    strcat(json_buffer, "]}");
                    free(databases);
                    
                    http_response_set_json_body(&context->response, json_buffer);
                } else {
                    http_response_set_json_body(&context->response, "{\"databases\":[]}");
                }
            }
        } else if (strncmp(context->request.path, "/api/", 5) == 0) {
            // Handle other API routes
            context->response.status_code = 501;
            context->response.status_message = "Not Implemented";
            http_response_set_json_body(&context->response, "{\"error\":\"Not implemented\"}");
        } else {
            context->response.status_code = 404;
            context->response.status_message = "Not Found";
            http_response_set_json_body(&context->response, "{\"error\":\"Endpoint not found\"}");
        }
    } else if (strcmp(context->request.method, "POST") == 0) {
        if (strcmp(context->request.path, "/api/execute") == 0) {
            // Execute SYDB commands via HTTP
            if (context->request.body) {
                // Parse JSON body to extract command and arguments
                char* command = json_get_string_value(context->request.body, "command");
                if (command) {
                    // This would need a more sophisticated command parser
                    // For now, return not implemented
                    context->response.status_code = 501;
                    context->response.status_message = "Not Implemented";
                    http_response_set_json_body(&context->response, "{\"error\":\"Command execution via HTTP not fully implemented\"}");
                    free(command);
                } else {
                    context->response.status_code = 400;
                    context->response.status_message = "Bad Request";
                    http_response_set_json_body(&context->response, "{\"error\":\"Invalid command format\"}");
                }
            } else {
                context->response.status_code = 400;
                context->response.status_message = "Bad Request";
                http_response_set_json_body(&context->response, "{\"error\":\"Missing request body\"}");
            }
        } else {
            context->response.status_code = 404;
            context->response.status_message = "Not Found";
            http_response_set_json_body(&context->response, "{\"error\":\"Endpoint not found\"}");
        }
    } else {
        context->response.status_code = 405;
        context->response.status_message = "Method Not Allowed";
        http_response_add_header(&context->response, "Allow", "GET, POST");
        http_response_set_json_body(&context->response, "{\"error\":\"Method not allowed\"}");
    }
    
    // Send response
    http_send_response(context->client_socket, &context->response);
    
    // Cleanup
    http_server_free_request(&context->request);
    http_server_free_response(&context->response);
    close(context->client_socket);
    free(context);
    
    return NULL;
}

void* http_accept_loop(void* arg) {
    http_server_t* server = (http_server_t*)arg;
    if (!server) return NULL;
    
    while (server->running) {
        struct sockaddr_in client_addr;
        socklen_t client_len = sizeof(client_addr);
        
        int client_socket = accept(server->server_socket, 
                                 (struct sockaddr*)&client_addr, 
                                 &client_len);
        
        if (client_socket < 0) {
            if (server->running) {
                perror("accept failed");
            }
            continue;
        }
        
        // Set socket timeout
        struct timeval timeout;
        timeout.tv_sec = 30;
        timeout.tv_usec = 0;
        setsockopt(client_socket, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
        setsockopt(client_socket, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
        
        // Read request
        char buffer[HTTP_SERVER_BUFFER_SIZE];
        ssize_t bytes_read = recv(client_socket, buffer, sizeof(buffer) - 1, 0);
        
        if (bytes_read > 0) {
            buffer[bytes_read] = '\0';
            
            http_client_context_t* context = malloc(sizeof(http_client_context_t));
            if (context) {
                context->client_socket = client_socket;
                context->client_address = client_addr;
                
                if (http_parse_request(buffer, bytes_read, &context->request) == 0) {
                    // Create thread to handle client
                    pthread_t client_thread;
                    if (pthread_create(&client_thread, NULL, http_client_handler, context) == 0) {
                        pthread_detach(client_thread);
                    } else {
                        // Thread creation failed, handle in current thread
                        http_client_handler(context);
                    }
                } else {
                    // Parse failed, send bad request
                    http_response_t response;
                    http_server_initialize_response(&response);
                    response.status_code = 400;
                    response.status_message = "Bad Request";
                    http_response_set_json_body(&response, "{\"error\":\"Invalid HTTP request\"}");
                    http_send_response(client_socket, &response);
                    http_server_free_response(&response);
                    close(client_socket);
                    free(context);
                }
            } else {
                close(client_socket);
            }
        } else {
            close(client_socket);
        }
    }
    
    return NULL;
}

int http_server_start(int port) {
    if (http_server_instance) {
        fprintf(stderr, "HTTP server is already running\n");
        return -1;
    }
    
    http_server_t* server = malloc(sizeof(http_server_t));
    if (!server) return -1;
    
    memset(server, 0, sizeof(http_server_t));
    server->port = port;
    server->running = true;
    
    // Initialize queue mutex and condition
    if (pthread_mutex_init(&server->queue_mutex, NULL) != 0) {
        free(server);
        return -1;
    }
    
    if (pthread_cond_init(&server->queue_condition, NULL) != 0) {
        pthread_mutex_destroy(&server->queue_mutex);
        free(server);
        return -1;
    }
    
    // Create server socket
    server->server_socket = socket(AF_INET, SOCK_STREAM, 0);
    if (server->server_socket < 0) {
        perror("socket creation failed");
        pthread_mutex_destroy(&server->queue_mutex);
        pthread_cond_destroy(&server->queue_condition);
        free(server);
        return -1;
    }
    
    // Set socket options
    int opt = 1;
    if (setsockopt(server->server_socket, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) < 0) {
        perror("setsockopt failed");
        close(server->server_socket);
        pthread_mutex_destroy(&server->queue_mutex);
        pthread_cond_destroy(&server->queue_condition);
        free(server);
        return -1;
    }
    
    // Bind socket
    struct sockaddr_in server_addr;
    memset(&server_addr, 0, sizeof(server_addr));
    server_addr.sin_family = AF_INET;
    server_addr.sin_addr.s_addr = INADDR_ANY;
    server_addr.sin_port = htons(port);
    
    if (bind(server->server_socket, (struct sockaddr*)&server_addr, sizeof(server_addr)) < 0) {
        perror("bind failed");
        close(server->server_socket);
        pthread_mutex_destroy(&server->queue_mutex);
        pthread_cond_destroy(&server->queue_condition);
        free(server);
        return -1;
    }
    
    // Listen for connections
    if (listen(server->server_socket, HTTP_SERVER_MAX_CONNECTIONS) < 0) {
        perror("listen failed");
        close(server->server_socket);
        pthread_mutex_destroy(&server->queue_mutex);
        pthread_cond_destroy(&server->queue_condition);
        free(server);
        return -1;
    }
    
    http_server_instance = server;
    
    // Create accept thread
    if (pthread_create(&server->accept_thread, NULL, http_accept_loop, server) != 0) {
        perror("pthread_create failed for accept thread");
        close(server->server_socket);
        pthread_mutex_destroy(&server->queue_mutex);
        pthread_cond_destroy(&server->queue_condition);
        free(server);
        http_server_instance = NULL;
        return -1;
    }
    
    printf("SYDB HTTP Server started on port %d\n", port);
    printf("Server is running...\n");
    
    return 0;
}

void http_server_stop() {
    if (!http_server_instance) return;
    
    http_server_instance->running = false;
    
    // Close server socket to break accept loop
    if (http_server_instance->server_socket >= 0) {
        close(http_server_instance->server_socket);
    }
    
    // Wait for accept thread to finish
    pthread_join(http_server_instance->accept_thread, NULL);
    
    // Cleanup
    pthread_mutex_destroy(&http_server_instance->queue_mutex);
    pthread_cond_destroy(&http_server_instance->queue_condition);
    
    free(http_server_instance);
    http_server_instance = NULL;
    
    printf("SYDB HTTP Server stopped\n");
}

void http_server_handle_signal(int signal) {
    printf("\nReceived signal %d, shutting down server...\n", signal);
    http_server_stop();
    exit(0);
}

// ==================== SECURE UTILITY FUNCTIONS ====================

void generate_secure_universally_unique_identifier(char* universally_unique_identifier) {
    if (!universally_unique_identifier) return;
    
    FILE* random_source = fopen("/dev/urandom", "rb");
    if (!random_source) {
        struct timespec current_time;
        clock_gettime(CLOCK_REALTIME, &current_time);
        unsigned int random_seed = (unsigned int)(current_time.tv_nsec ^ current_time.tv_sec ^ getpid());
        srand(random_seed);
    }
    
    const char* hexadecimal_characters = "0123456789abcdef";
    int segment_lengths[] = {8, 4, 4, 4, 12};
    int current_position = 0;
    
    for (int segment_index = 0; segment_index < 5; segment_index++) {
        if (segment_index > 0) {
            universally_unique_identifier[current_position++] = '-';
        }
        for (int character_index = 0; character_index < segment_lengths[segment_index]; character_index++) {
            unsigned char random_byte;
            if (random_source) {
                fread(&random_byte, 1, 1, random_source);
            } else {
                random_byte = rand() % 256;
            }
            universally_unique_identifier[current_position++] = hexadecimal_characters[random_byte % 16];
        }
    }
    universally_unique_identifier[current_position] = '\0';
    
    if (random_source) {
        fclose(random_source);
    }
}

int create_secure_directory_recursively(const char* path) {
    if (!path || strlen(path) == 0 || strlen(path) >= MAXIMUM_PATH_LENGTH) {
        return -1;
    }
    
    struct stat status_info;
    if (stat(path, &status_info) == 0) {
        return S_ISDIR(status_info.st_mode) ? 0 : -1;
    }
    
    char temporary_path[MAXIMUM_PATH_LENGTH];
    if (snprintf(temporary_path, sizeof(temporary_path), "%s", path) >= (int)sizeof(temporary_path)) {
        return -1;
    }
    
    size_t path_length = strlen(temporary_path);
    if (path_length > 0 && temporary_path[path_length - 1] == '/') {
        temporary_path[path_length - 1] = '\0';
    }
    
    for (size_t i = 1; i < strlen(temporary_path); i++) {
        if (temporary_path[i] == '/') {
            temporary_path[i] = '\0';
            
            if (strlen(temporary_path) > 0) {
                if (mkdir(temporary_path, 0755) == -1) {
                    if (errno != EEXIST) {
                        fprintf(stderr, "Error creating directory %s: %s\n", temporary_path, strerror(errno));
                        return -1;
                    }
                }
            }
            
            temporary_path[i] = '/';
        }
    }
    
    if (mkdir(temporary_path, 0755) == -1) {
        if (errno != EEXIST) {
            fprintf(stderr, "Error creating directory %s: %s\n", temporary_path, strerror(errno));
            return -1;
        }
    }
    
    if (stat(path, &status_info) == 0 && S_ISDIR(status_info.st_mode)) {
        return 0;
    }
    
    return -1;
}

uint32_t compute_crc_32_checksum(const void* data, size_t length) {
    if (!data || length == 0) return 0;
    
    const uint8_t* data_bytes = (const uint8_t*)data;
    uint32_t checksum = 0xFFFFFFFF;
    static uint32_t checksum_table[256];
    static bool checksum_table_computed = false;
    
    if (!checksum_table_computed) {
        for (uint32_t table_index = 0; table_index < 256; table_index++) {
            uint32_t table_entry = table_index;
            for (int bit_index = 0; bit_index < 8; bit_index++) {
                table_entry = (table_entry >> 1) ^ (0xEDB88320 & -(table_entry & 1));
            }
            checksum_table[table_index] = table_entry;
        }
        checksum_table_computed = true;
    }
    
    for (size_t byte_index = 0; byte_index < length; byte_index++) {
        checksum = (checksum >> 8) ^ checksum_table[(checksum ^ data_bytes[byte_index]) & 0xFF];
    }
    
    return ~checksum;
}

char* get_secure_sydb_base_directory_path() {
    static char base_directory_path[MAXIMUM_PATH_LENGTH];
    const char* environment_directory = getenv("SYDB_BASE_DIR");
    
    if (environment_directory && strlen(environment_directory) < MAXIMUM_PATH_LENGTH) {
        if (snprintf(base_directory_path, sizeof(base_directory_path), "%s", environment_directory) >= (int)sizeof(base_directory_path)) {
            strncpy(base_directory_path, SYDB_BASE_DIRECTORY, MAXIMUM_PATH_LENGTH - 1);
        }
    } else {
        strncpy(base_directory_path, SYDB_BASE_DIRECTORY, MAXIMUM_PATH_LENGTH - 1);
    }
    base_directory_path[MAXIMUM_PATH_LENGTH - 1] = '\0';
    
    return base_directory_path;
}

int acquire_secure_exclusive_lock(const char* lock_file_path) {
    if (!lock_file_path || strlen(lock_file_path) >= MAXIMUM_PATH_LENGTH) {
        return -1;
    }
    
    int file_descriptor = open(lock_file_path, O_CREAT | O_RDWR, 0644);
    if (file_descriptor == -1) {
        fprintf(stderr, "Error creating lock file %s: %s\n", lock_file_path, strerror(errno));
        return -1;
    }
    
    struct timespec timeout_time;
    if (clock_gettime(CLOCK_REALTIME, &timeout_time) == -1) {
        close(file_descriptor);
        return -1;
    }
    timeout_time.tv_sec += LOCK_TIMEOUT_SECONDS;
    
    struct timespec current_time;
    while (clock_gettime(CLOCK_REALTIME, &current_time) != -1) {
        if (current_time.tv_sec > timeout_time.tv_sec || 
            (current_time.tv_sec == timeout_time.tv_sec && current_time.tv_nsec >= timeout_time.tv_nsec)) {
            fprintf(stderr, "Timeout: Could not acquire lock on %s after %d seconds\n", 
                    lock_file_path, LOCK_TIMEOUT_SECONDS);
            close(file_descriptor);
            return -1;
        }
        
        if (flock(file_descriptor, LOCK_EX | LOCK_NB) == 0) {
            return file_descriptor;
        }
        
        if (errno != EWOULDBLOCK) {
            fprintf(stderr, "Error acquiring lock on %s: %s\n", lock_file_path, strerror(errno));
            close(file_descriptor);
            return -1;
        }
        
        struct timespec sleep_time = {0, 100000000};
        nanosleep(&sleep_time, NULL);
    }
    
    close(file_descriptor);
    return -1;
}

void release_secure_exclusive_lock(int file_descriptor, const char* lock_file_path) {
    if (file_descriptor != -1) {
        flock(file_descriptor, LOCK_UN);
        close(file_descriptor);
    }
}

// ==================== SECURE CACHE IMPLEMENTATION ====================

lru_cache_t* create_secure_lru_cache(size_t capacity) {
    if (capacity == 0 || capacity > CACHE_CAPACITY) {
        return NULL;
    }
    
    lru_cache_t* cache = secure_malloc(sizeof(lru_cache_t));
    if (!cache) return NULL;
    
    cache->entries = secure_malloc(capacity * sizeof(cache_entry_t*));
    if (!cache->entries) {
        secure_free((void**)&cache);
        return NULL;
    }
    
    cache->capacity = capacity;
    cache->size = 0;
    cache->cache_hits = 0;
    cache->cache_misses = 0;
    cache->head_entry = NULL;
    cache->tail_entry = NULL;
    
    if (pthread_rwlock_init(&cache->lock, NULL) != 0) {
        secure_free((void**)&cache->entries);
        secure_free((void**)&cache);
        return NULL;
    }
    
    return cache;
}

void destroy_secure_lru_cache(lru_cache_t* cache) {
    if (!cache) return;
    
    pthread_rwlock_wrlock(&cache->lock);
    
    cache_entry_t* current_entry = cache->head_entry;
    while (current_entry) {
        cache_entry_t* next_entry = current_entry->next_entry;
        if (current_entry->instance) {
            secure_free((void**)&current_entry->instance->binary_data);
            secure_free((void**)&current_entry->instance);
        }
        secure_free((void**)&current_entry);
        current_entry = next_entry;
    }
    
    secure_free((void**)&cache->entries);
    pthread_rwlock_unlock(&cache->lock);
    pthread_rwlock_destroy(&cache->lock);
    secure_free((void**)&cache);
}

void lru_cache_put_secure(lru_cache_t* cache, const char* universally_unique_identifier, database_instance_t* instance) {
    if (!cache || !universally_unique_identifier || !instance) return;
    if (strlen(universally_unique_identifier) >= UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE) return;
    
    pthread_rwlock_wrlock(&cache->lock);
    
    size_t hash_index = compute_crc_32_checksum(universally_unique_identifier, strlen(universally_unique_identifier)) % cache->capacity;
    cache_entry_t* existing_entry = cache->entries[hash_index];
    cache_entry_t* previous_entry = NULL;
    
    while (existing_entry) {
        if (strcmp(existing_entry->universally_unique_identifier, universally_unique_identifier) == 0) {
            if (existing_entry->instance->binary_data) {
                secure_free((void**)&existing_entry->instance->binary_data);
            }
            free(existing_entry->instance);
            existing_entry->instance = instance;
            existing_entry->last_accessed_time = time(NULL);
            existing_entry->access_count++;
            
            if (existing_entry != cache->head_entry) {
                if (existing_entry->previous_entry) {
                    existing_entry->previous_entry->next_entry = existing_entry->next_entry;
                }
                if (existing_entry->next_entry) {
                    existing_entry->next_entry->previous_entry = existing_entry->previous_entry;
                }
                if (existing_entry == cache->tail_entry) {
                    cache->tail_entry = existing_entry->previous_entry;
                }
                
                existing_entry->next_entry = cache->head_entry;
                existing_entry->previous_entry = NULL;
                if (cache->head_entry) {
                    cache->head_entry->previous_entry = existing_entry;
                }
                cache->head_entry = existing_entry;
                if (!cache->tail_entry) {
                    cache->tail_entry = existing_entry;
                }
            }
            
            pthread_rwlock_unlock(&cache->lock);
            return;
        }
        previous_entry = existing_entry;
        existing_entry = existing_entry->next_entry;
    }
    
    cache_entry_t* new_cache_entry = secure_malloc(sizeof(cache_entry_t));
    if (!new_cache_entry) {
        pthread_rwlock_unlock(&cache->lock);
        return;
    }
    
    strncpy(new_cache_entry->universally_unique_identifier, universally_unique_identifier, UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE - 1);
    new_cache_entry->universally_unique_identifier[UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE - 1] = '\0';
    new_cache_entry->instance = instance;
    new_cache_entry->last_accessed_time = time(NULL);
    new_cache_entry->access_count = 1;
    new_cache_entry->next_entry = NULL;
    new_cache_entry->previous_entry = NULL;
    
    new_cache_entry->next_entry = cache->entries[hash_index];
    if (cache->entries[hash_index]) {
        cache->entries[hash_index]->previous_entry = new_cache_entry;
    }
    cache->entries[hash_index] = new_cache_entry;
    
    new_cache_entry->next_entry = cache->head_entry;
    if (cache->head_entry) {
        cache->head_entry->previous_entry = new_cache_entry;
    }
    cache->head_entry = new_cache_entry;
    if (!cache->tail_entry) {
        cache->tail_entry = new_cache_entry;
    }
    
    cache->size++;
    
    if (cache->size > cache->capacity) {
        cache_entry_t* least_recently_used_entry = cache->tail_entry;
        if (least_recently_used_entry) {
            size_t tail_hash_index = compute_crc_32_checksum(least_recently_used_entry->universally_unique_identifier, 
                                                           strlen(least_recently_used_entry->universally_unique_identifier)) % cache->capacity;
            cache_entry_t* hash_entry = cache->entries[tail_hash_index];
            cache_entry_t* hash_previous_entry = NULL;
            
            while (hash_entry) {
                if (hash_entry == least_recently_used_entry) {
                    if (hash_previous_entry) {
                        hash_previous_entry->next_entry = hash_entry->next_entry;
                    } else {
                        cache->entries[tail_hash_index] = hash_entry->next_entry;
                    }
                    if (hash_entry->next_entry) {
                        hash_entry->next_entry->previous_entry = hash_previous_entry;
                    }
                    break;
                }
                hash_previous_entry = hash_entry;
                hash_entry = hash_entry->next_entry;
            }
            
            if (least_recently_used_entry->previous_entry) {
                least_recently_used_entry->previous_entry->next_entry = NULL;
            }
            cache->tail_entry = least_recently_used_entry->previous_entry;
            if (cache->head_entry == least_recently_used_entry) {
                cache->head_entry = NULL;
            }
            
            if (least_recently_used_entry->instance) {
                secure_free((void**)&least_recently_used_entry->instance->binary_data);
                secure_free((void**)&least_recently_used_entry->instance);
            }
            secure_free((void**)&least_recently_used_entry);
            cache->size--;
        }
    }
    
    pthread_rwlock_unlock(&cache->lock);
}

database_instance_t* lru_cache_get_secure(lru_cache_t* cache, const char* universally_unique_identifier) {
    if (!cache || !universally_unique_identifier) return NULL;
    if (strlen(universally_unique_identifier) >= UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE) return NULL;
    
    pthread_rwlock_rdlock(&cache->lock);
    
    size_t hash_index = compute_crc_32_checksum(universally_unique_identifier, strlen(universally_unique_identifier)) % cache->capacity;
    cache_entry_t* cache_entry = cache->entries[hash_index];
    
    while (cache_entry) {
        if (strcmp(cache_entry->universally_unique_identifier, universally_unique_identifier) == 0) {
            cache_entry->last_accessed_time = time(NULL);
            cache_entry->access_count++;
            cache->cache_hits++;
            
            pthread_rwlock_unlock(&cache->lock);
            pthread_rwlock_wrlock(&cache->lock);
            
            if (cache_entry != cache->head_entry) {
                if (cache_entry->previous_entry) {
                    cache_entry->previous_entry->next_entry = cache_entry->next_entry;
                }
                if (cache_entry->next_entry) {
                    cache_entry->next_entry->previous_entry = cache_entry->previous_entry;
                }
                if (cache_entry == cache->tail_entry) {
                    cache->tail_entry = cache_entry->previous_entry;
                }
                
                cache_entry->next_entry = cache->head_entry;
                cache_entry->previous_entry = NULL;
                if (cache->head_entry) {
                    cache->head_entry->previous_entry = cache_entry;
                }
                cache->head_entry = cache_entry;
                if (!cache->tail_entry) {
                    cache->tail_entry = cache_entry;
                }
            }
            
            pthread_rwlock_unlock(&cache->lock);
            return cache_entry->instance;
        }
        cache_entry = cache_entry->next_entry;
    }
    
    cache->cache_misses++;
    pthread_rwlock_unlock(&cache->lock);
    return NULL;
}

// ==================== SECURE B-TREE INDEX IMPLEMENTATION ====================

b_tree_node_t* create_secure_b_tree_node(bool is_leaf_node) {
    b_tree_node_t* new_node = secure_malloc(sizeof(b_tree_node_t));
    if (!new_node) return NULL;
    
    new_node->key_count = 0;
    new_node->is_leaf = is_leaf_node;
    new_node->node_offset = 0;
    memset(new_node->child_node_offsets, 0, sizeof(new_node->child_node_offsets));
    memset(new_node->record_offsets, 0, sizeof(new_node->record_offsets));
    
    return new_node;
}

int b_tree_search_node_secure(b_tree_node_t* node, const char* search_key, uint64_t* record_offset) {
    if (!node || !search_key || !record_offset) return 0;
    if (strlen(search_key) >= MAXIMUM_FIELD_LENGTH) return 0;
    
    int key_index = 0;
    while (key_index < node->key_count && strcmp(search_key, node->keys[key_index]) > 0) {
        key_index++;
    }
    
    if (key_index < node->key_count && strcmp(search_key, node->keys[key_index]) == 0) {
        *record_offset = node->record_offsets[key_index];
        return 1;
    }
    
    if (node->is_leaf) {
        return 0;
    }
    
    return 0;
}

void b_tree_insert_non_full_node_secure(b_tree_node_t* node, const char* key, uint64_t record_offset) {
    if (!node || !key || strlen(key) >= MAXIMUM_FIELD_LENGTH) return;
    
    int key_index = node->key_count - 1;
    
    if (node->is_leaf) {
        while (key_index >= 0 && strcmp(key, node->keys[key_index]) < 0) {
            strcpy(node->keys[key_index + 1], node->keys[key_index]);
            node->record_offsets[key_index + 1] = node->record_offsets[key_index];
            key_index--;
        }
        
        strncpy(node->keys[key_index + 1], key, MAXIMUM_FIELD_LENGTH - 1);
        node->keys[key_index + 1][MAXIMUM_FIELD_LENGTH - 1] = '\0';
        node->record_offsets[key_index + 1] = record_offset;
        node->key_count++;
    } else {
        while (key_index >= 0 && strcmp(key, node->keys[key_index]) < 0) {
            key_index--;
        }
        key_index++;
    }
}

void b_tree_insert_into_index_secure(field_index_t* index, const char* key, uint64_t record_offset) {
    if (!index || !key) return;
    
    pthread_rwlock_wrlock(&index->lock);
    
    b_tree_node_t* root_node = index->root_node;
    
    if (root_node->key_count == B_TREE_ORDER - 1) {
        b_tree_node_t* new_root_node = create_secure_b_tree_node(false);
        if (new_root_node) {
            new_root_node->child_node_offsets[0] = (uint64_t)root_node;
            index->root_node = new_root_node;
        }
    } else {
        b_tree_insert_non_full_node_secure(root_node, key, record_offset);
    }
    
    pthread_rwlock_unlock(&index->lock);
}

// ==================== SECURE HIGH-PERFORMANCE FILE OPERATIONS ====================

FILE* open_secure_data_file_with_optimizations(const char* database_name, const char* collection_name, const char* mode) {
    if (!validate_database_name(database_name) || !validate_collection_name(collection_name)) {
        return NULL;
    }
    
    char file_path[MAXIMUM_PATH_LENGTH];
    int written = snprintf(file_path, sizeof(file_path), "%s/%s/%s/data%s", 
                          get_secure_sydb_base_directory_path(), database_name, collection_name, DATA_FILE_EXTENSION);
    
    if (written < 0 || written >= (int)sizeof(file_path)) {
        return NULL;
    }
    
    FILE* data_file = fopen(file_path, mode);
    if (!data_file && strcmp(mode, "r+b") == 0) {
        data_file = fopen(file_path, "w+b");
    }
    
    if (data_file) {
        setvbuf(data_file, NULL, _IOFBF, 65536);
    }
    
    return data_file;
}

int initialize_secure_high_performance_data_file(FILE* data_file) {
    if (!data_file) return -1;
    
    file_header_t file_header = {
        .magic_number = FILE_MAGIC_NUMBER,
        .version_number = FILE_VERSION_NUMBER,
        .record_count = 0,
        .file_size = sizeof(file_header_t),
        .free_offset = sizeof(file_header_t),
        .schema_checksum = 0,
        .index_root_offset = 0,
        .flags = 0
    };
    memset(file_header.reserved, 0, sizeof(file_header.reserved));
    
    if (fseek(data_file, 0, SEEK_SET) != 0) return -1;
    if (fwrite(&file_header, sizeof(file_header_t), 1, data_file) != 1) return -1;
    return fflush(data_file);
}

int read_secure_file_header_information(FILE* data_file, file_header_t* file_header) {
    if (!data_file || !file_header) return -1;
    
    if (fseek(data_file, 0, SEEK_SET) != 0) return -1;
    if (fread(file_header, sizeof(file_header_t), 1, data_file) != 1) return -1;
    
    if (file_header->magic_number != FILE_MAGIC_NUMBER) {
        return -1;
    }
    
    return 0;
}

int write_secure_file_header_information(FILE* data_file, file_header_t* file_header) {
    if (!data_file || !file_header) return -1;
    
    if (fseek(data_file, 0, SEEK_SET) != 0) return -1;
    if (fwrite(file_header, sizeof(file_header_t), 1, data_file) != 1) return -1;
    return fflush(data_file);
}

// ==================== SECURE CONCURRENCY CONTROL ====================

int initialize_secure_collection_locks(collection_lock_t* locks) {
    if (!locks) return -1;
    
    int result = 0;
    result |= pthread_rwlock_init(&locks->schema_lock, NULL);
    result |= pthread_rwlock_init(&locks->data_lock, NULL);
    result |= pthread_mutex_init(&locks->cache_lock, NULL);
    result |= pthread_rwlock_init(&locks->index_lock, NULL);
    result |= pthread_cond_init(&locks->write_complete_condition, NULL);
    
    locks->active_readers_count = 0;
    locks->waiting_writers_count = 0;
    locks->writer_active = false;
    
    return result;
}

void acquire_secure_collection_read_lock(collection_lock_t* locks) {
    if (!locks) return;
    
    pthread_mutex_lock(&locks->cache_lock);
    while (locks->writer_active || locks->waiting_writers_count > 0) {
        pthread_cond_wait(&locks->write_complete_condition, &locks->cache_lock);
    }
    locks->active_readers_count++;
    pthread_mutex_unlock(&locks->cache_lock);
}

void release_secure_collection_read_lock(collection_lock_t* locks) {
    if (!locks) return;
    
    pthread_mutex_lock(&locks->cache_lock);
    locks->active_readers_count--;
    if (locks->active_readers_count == 0 && locks->waiting_writers_count > 0) {
        pthread_cond_signal(&locks->write_complete_condition);
    }
    pthread_mutex_unlock(&locks->cache_lock);
}

void acquire_secure_collection_write_lock(collection_lock_t* locks) {
    if (!locks) return;
    
    pthread_mutex_lock(&locks->cache_lock);
    locks->waiting_writers_count++;
    while (locks->writer_active || locks->active_readers_count > 0) {
        pthread_cond_wait(&locks->write_complete_condition, &locks->cache_lock);
    }
    locks->waiting_writers_count--;
    locks->writer_active = true;
    pthread_mutex_unlock(&locks->cache_lock);
}

void release_secure_collection_write_lock(collection_lock_t* locks) {
    if (!locks) return;
    
    pthread_mutex_lock(&locks->cache_lock);
    locks->writer_active = false;
    pthread_cond_broadcast(&locks->write_complete_condition);
    pthread_mutex_unlock(&locks->cache_lock);
}

// ==================== SECURE SCHEMA MANAGEMENT ====================

field_type_t parse_secure_field_type_from_string(const char* type_string) {
    if (!type_string) return FIELD_TYPE_NULL;
    
    if (strcmp(type_string, "string") == 0) return FIELD_TYPE_STRING;
    if (strcmp(type_string, "int") == 0) return FIELD_TYPE_INTEGER;
    if (strcmp(type_string, "float") == 0) return FIELD_TYPE_FLOAT;
    if (strcmp(type_string, "bool") == 0) return FIELD_TYPE_BOOLEAN;
    if (strcmp(type_string, "array") == 0) return FIELD_TYPE_ARRAY;
    if (strcmp(type_string, "object") == 0) return FIELD_TYPE_OBJECT;
    return FIELD_TYPE_NULL;
}

const char* convert_secure_field_type_to_string(field_type_t type) {
    switch (type) {
        case FIELD_TYPE_STRING: return "string";
        case FIELD_TYPE_INTEGER: return "int";
        case FIELD_TYPE_FLOAT: return "float";
        case FIELD_TYPE_BOOLEAN: return "bool";
        case FIELD_TYPE_ARRAY: return "array";
        case FIELD_TYPE_OBJECT: return "object";
        default: return "null";
    }
}

int parse_secure_schema_fields_from_arguments(int argument_count, char* argument_values[], int start_index, 
                                             field_schema_t* fields, int* field_count) {
    if (!argument_values || !fields || !field_count || argument_count <= start_index) {
        return -1;
    }
    
    *field_count = 0;
    
    for (int argument_index = start_index; argument_index < argument_count && *field_count < MAXIMUM_FIELDS; argument_index++) {
        char* field_specification = argument_values[argument_index];
        if (!field_specification || strncmp(field_specification, "--", 2) != 0) continue;
        
        field_specification += 2;
        
        char field_name[MAXIMUM_FIELD_LENGTH];
        char type_string[32];
        bool required = false;
        bool indexed = false;
        
        char* first_dash = strchr(field_specification, '-');
        if (!first_dash) continue;
        
        *first_dash = '\0';
        strncpy(field_name, field_specification, MAXIMUM_FIELD_LENGTH - 1);
        field_name[MAXIMUM_FIELD_LENGTH - 1] = '\0';
        
        if (!validate_field_name(field_name)) {
            fprintf(stderr, "Error: Invalid field name '%s'\n", field_name);
            return -1;
        }
        
        char* second_dash = strchr(first_dash + 1, '-');
        if (second_dash) {
            *second_dash = '\0';
            strncpy(type_string, first_dash + 1, sizeof(type_string) - 1);
            type_string[sizeof(type_string) - 1] = '\0';
            
            char* third_dash = strchr(second_dash + 1, '-');
            if (third_dash) {
                *third_dash = '\0';
                required = (strcmp(second_dash + 1, "req") == 0);
                indexed = (strcmp(third_dash + 1, "idx") == 0);
            } else {
                required = (strcmp(second_dash + 1, "req") == 0);
            }
        } else {
            strncpy(type_string, first_dash + 1, sizeof(type_string) - 1);
            type_string[sizeof(type_string) - 1] = '\0';
        }
        
        field_type_t type = parse_secure_field_type_from_string(type_string);
        if (type == FIELD_TYPE_NULL) {
            fprintf(stderr, "Error: Unknown field type '%s' for field '%s'\n", 
                    type_string, field_name);
            return -1;
        }
        
        strncpy(fields[*field_count].name, field_name, MAXIMUM_FIELD_LENGTH - 1);
        fields[*field_count].name[MAXIMUM_FIELD_LENGTH - 1] = '\0';
        fields[*field_count].type = type;
        fields[*field_count].required = required;
        fields[*field_count].indexed = indexed;
        (*field_count)++;
    }
    
    return 0;
}

int load_secure_schema_from_file(const char* database_name, const char* collection_name, 
                                field_schema_t* fields, int* field_count) {
    if (!validate_database_name(database_name) || !validate_collection_name(collection_name) || !fields || !field_count) {
        return -1;
    }
    
    char schema_file_path[MAXIMUM_PATH_LENGTH];
    int written = snprintf(schema_file_path, sizeof(schema_file_path), "%s/%s/%s/schema.txt", 
                          get_secure_sydb_base_directory_path(), database_name, collection_name);
    
    if (written < 0 || written >= (int)sizeof(schema_file_path)) {
        return -1;
    }
    
    FILE* schema_file = fopen(schema_file_path, "r");
    if (!schema_file) {
        fprintf(stderr, "Error: Cannot load schema for collection '%s'\n", collection_name);
        return -1;
    }
    
    *field_count = 0;
    char line_buffer[256];
    
    while (fgets(line_buffer, sizeof(line_buffer), schema_file) && *field_count < MAXIMUM_FIELDS) {
        line_buffer[strcspn(line_buffer, "\n")] = '\0';
        
        if (strlen(line_buffer) == 0) continue;
        
        char* first_colon = strchr(line_buffer, ':');
        char* second_colon = first_colon ? strchr(first_colon + 1, ':') : NULL;
        char* third_colon = second_colon ? strchr(second_colon + 1, ':') : NULL;
        
        if (!first_colon || !second_colon) continue;
        
        *first_colon = '\0';
        *second_colon = '\0';
        if (third_colon) *third_colon = '\0';
        
        char* field_name = line_buffer;
        char* type_string = first_colon + 1;
        char* required_string = second_colon + 1;
        char* indexed_string = third_colon ? third_colon + 1 : "unindexed";
        
        if (!validate_field_name(field_name)) {
            continue;
        }
        
        strncpy(fields[*field_count].name, field_name, MAXIMUM_FIELD_LENGTH - 1);
        fields[*field_count].name[MAXIMUM_FIELD_LENGTH - 1] = '\0';
        fields[*field_count].type = parse_secure_field_type_from_string(type_string);
        fields[*field_count].required = (strcmp(required_string, "required") == 0);
        fields[*field_count].indexed = (strcmp(indexed_string, "indexed") == 0);
        (*field_count)++;
    }
    
    fclose(schema_file);
    return 0;
}

bool validate_secure_field_value_against_schema(const char* field_name, const char* value, field_type_t type) {
    if (!field_name || !validate_field_name(field_name)) {
        return false;
    }
    
    if (!value || strlen(value) == 0) {
        return true;
    }
    
    if (strlen(value) >= MAXIMUM_LINE_LENGTH) {
        fprintf(stderr, "Validation error: Field '%s' value too long\n", field_name);
        return false;
    }
    
    switch (type) {
        case FIELD_TYPE_INTEGER: {
            char* end_pointer;
            long integer_value = strtol(value, &end_pointer, 10);
            if (*end_pointer != '\0') {
                fprintf(stderr, "Validation error: Field '%s' should be integer but got '%s'\n", 
                        field_name, value);
                return false;
            }
            return true;
        }
        case FIELD_TYPE_FLOAT: {
            char* end_pointer;
            double float_value = strtod(value, &end_pointer);
            if (*end_pointer != '\0') {
                fprintf(stderr, "Validation error: Field '%s' should be float but got '%s'\n", 
                        field_name, value);
                return false;
            }
            return true;
        }
        case FIELD_TYPE_BOOLEAN: {
            if (strcmp(value, "true") != 0 && strcmp(value, "false") != 0 &&
                strcmp(value, "1") != 0 && strcmp(value, "0") != 0) {
                fprintf(stderr, "Validation error: Field '%s' should be boolean but got '%s'\n", 
                        field_name, value);
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

int validate_secure_instance_against_schema(const char* instance_json, 
                                           field_schema_t* fields, int field_count) {
    if (!instance_json || !fields || field_count <= 0 || field_count > MAXIMUM_FIELDS) {
        return -1;
    }
    
    for (int field_index = 0; field_index < field_count; field_index++) {
        if (fields[field_index].required && !json_has_field(instance_json, fields[field_index].name)) {
            fprintf(stderr, "Validation error: Required field '%s' is missing\n", 
                    fields[field_index].name);
            return -1;
        }
        
        if (json_has_field(instance_json, fields[field_index].name)) {
            char* field_value = json_get_string_value(instance_json, fields[field_index].name);
            if (field_value) {
                if (!validate_secure_field_value_against_schema(fields[field_index].name, field_value, fields[field_index].type)) {
                    free(field_value);
                    return -1;
                }
                free(field_value);
            }
        }
    }
    return 0;
}

void print_secure_collection_schema(const char* database_name, const char* collection_name) {
    if (!validate_database_name(database_name) || !validate_collection_name(collection_name)) {
        fprintf(stderr, "Error: Invalid database or collection name\n");
        return;
    }
    
    field_schema_t fields[MAXIMUM_FIELDS];
    int field_count = 0;
    
    if (load_secure_schema_from_file(database_name, collection_name, fields, &field_count) == -1) {
        fprintf(stderr, "Error: Cannot load schema for collection '%s'\n", collection_name);
        return;
    }
    
    printf("Field               Type       Required   Indexed   \n");
    printf("----------------------------------------------------\n");
    
    for (int field_index = 0; field_index < field_count; field_index++) {
        printf("%-20s %-10s %-10s %-10s\n", 
               fields[field_index].name, 
               convert_secure_field_type_to_string(fields[field_index].type),
               fields[field_index].required ? "Yes" : "No",
               fields[field_index].indexed ? "Yes" : "No");
    }
}

// ==================== SECURE JSON PARSING FUNCTIONS ====================

char* json_get_string_value(const char* json_data, const char* key) {
    if (!json_data || !key || strlen(key) >= 200) return NULL;
    
    char search_pattern[256];
    int written = snprintf(search_pattern, sizeof(search_pattern), "\"%s\":\"", key);
    if (written < 0 || written >= (int)sizeof(search_pattern)) return NULL;
    
    char* value_start = strstr(json_data, search_pattern);
    if (!value_start) {
        // Try without quotes for the value
        written = snprintf(search_pattern, sizeof(search_pattern), "\"%s\":", key);
        if (written < 0 || written >= (int)sizeof(search_pattern)) return NULL;
        
        value_start = strstr(json_data, search_pattern);
        if (!value_start) return NULL;
        
        value_start += strlen(search_pattern);
        char* value_end = strchr(value_start, ',');
        if (!value_end) value_end = strchr(value_start, '}');
        if (!value_end) return NULL;
        
        size_t value_length = value_end - value_start;
        if (value_length >= MAXIMUM_LINE_LENGTH) return NULL;
        
        char* extracted_value = malloc(value_length + 1);
        if (!extracted_value) return NULL;
        
        strncpy(extracted_value, value_start, value_length);
        extracted_value[value_length] = '\0';
        
        // Remove any trailing whitespace
        char* end = extracted_value + strlen(extracted_value) - 1;
        while (end > extracted_value && (*end == ' ' || *end == '\t' || *end == '\n' || *end == '\r')) {
            *end = '\0';
            end--;
        }
        return extracted_value;
    }
    
    value_start += strlen(search_pattern);
    char* value_end = strchr(value_start, '"');
    if (!value_end) return NULL;
    
    size_t value_length = value_end - value_start;
    if (value_length >= MAXIMUM_LINE_LENGTH) return NULL;
    
    char* extracted_value = malloc(value_length + 1);
    if (!extracted_value) return NULL;
    
    strncpy(extracted_value, value_start, value_length);
    extracted_value[value_length] = '\0';
    return extracted_value;
}

int json_get_integer_value(const char* json_data, const char* key) {
    if (!json_data || !key) return 0;
    
    char search_pattern[256];
    int written = snprintf(search_pattern, sizeof(search_pattern), "\"%s\":", key);
    if (written < 0 || written >= (int)sizeof(search_pattern)) return 0;
    
    char* value_start = strstr(json_data, search_pattern);
    if (!value_start) return 0;
    
    value_start += strlen(search_pattern);
    return atoi(value_start);
}

bool json_has_field(const char* json_data, const char* key) {
    if (!json_data || !key) return false;
    
    char search_pattern[256];
    int written = snprintf(search_pattern, sizeof(search_pattern), "\"%s\":", key);
    if (written < 0 || written >= (int)sizeof(search_pattern)) return false;
    
    return strstr(json_data, search_pattern) != NULL;
}

bool json_matches_query_conditions(const char* json_data, const char* query) {
    if (!json_data) return false;
    
    // Handle empty query - should match all records
    if (!query || strlen(query) == 0) {
        return true;
    }
    
    if (strlen(query) >= 1024) return false;
    
    char query_copy[1024];
    strncpy(query_copy, query, sizeof(query_copy) - 1);
    query_copy[sizeof(query_copy) - 1] = '\0';
    
    char* query_token = strtok(query_copy, ",");
    while (query_token) {
        // Trim whitespace
        while (*query_token == ' ') query_token++;
        char* token_end = query_token + strlen(query_token) - 1;
        while (token_end > query_token && *token_end == ' ') {
            *token_end = '\0';
            token_end--;
        }
        
        char* colon_position = strchr(query_token, ':');
        if (!colon_position) {
            // Invalid query format - no colon found
            return false;
        }
        
        *colon_position = '\0';
        char* field_name = query_token;
        char* expected_value = colon_position + 1;
        
        // Trim field name
        char* field_end = field_name + strlen(field_name) - 1;
        while (field_end > field_name && *field_end == ' ') {
            *field_end = '\0';
            field_end--;
        }
        
        if (!validate_field_name(field_name)) {
            return false;
        }
        
        // Trim and handle quoted expected values
        while (*expected_value == ' ') expected_value++;
        char* value_end = expected_value + strlen(expected_value) - 1;
        while (value_end > expected_value && *value_end == ' ') {
            *value_end = '\0';
            value_end--;
        }
        
        // Remove quotes if present
        if (expected_value[0] == '"' && expected_value[strlen(expected_value)-1] == '"') {
            expected_value[strlen(expected_value)-1] = '\0';
            expected_value++;
        }
        
        char* actual_string_value = json_get_string_value(json_data, field_name);
        if (actual_string_value) {
            bool matches = (strcmp(actual_string_value, expected_value) == 0);
            free(actual_string_value);
            if (!matches) return false;
        } else {
            // Try integer comparison
            int actual_integer_value = json_get_integer_value(json_data, field_name);
            int expected_integer_value = atoi(expected_value);
            if (actual_integer_value != expected_integer_value) {
                return false;
            }
        }
        
        query_token = strtok(NULL, ",");
    }
    
    return true;
}

// ==================== SECURE DATABASE OPERATIONS ====================

int database_secure_exists(const char* database_name) {
    if (!validate_database_name(database_name)) return 0;
    
    char database_path[MAXIMUM_PATH_LENGTH];
    int written = snprintf(database_path, sizeof(database_path), "%s/%s", 
                          get_secure_sydb_base_directory_path(), database_name);
    
    if (written < 0 || written >= (int)sizeof(database_path)) return 0;
    
    struct stat status_info;
    return (stat(database_path, &status_info) == 0 && S_ISDIR(status_info.st_mode));
}

int collection_secure_exists(const char* database_name, const char* collection_name) {
    if (!validate_database_name(database_name) || !validate_collection_name(collection_name)) return 0;
    
    char collection_path[MAXIMUM_PATH_LENGTH];
    int written = snprintf(collection_path, sizeof(collection_path), "%s/%s/%s", 
                          get_secure_sydb_base_directory_path(), database_name, collection_name);
    
    if (written < 0 || written >= (int)sizeof(collection_path)) return 0;
    
    struct stat status_info;
    return (stat(collection_path, &status_info) == 0 && S_ISDIR(status_info.st_mode));
}

int create_secure_database(const char* database_name) {
    if (!validate_database_name(database_name)) {
        fprintf(stderr, "Error: Invalid database name '%s'\n", database_name);
        return -1;
    }
    
    if (database_secure_exists(database_name)) {
        fprintf(stderr, "Error: Database '%s' already exists\n", database_name);
        return -1;
    }
    
    char base_directory[MAXIMUM_PATH_LENGTH];
    strncpy(base_directory, get_secure_sydb_base_directory_path(), MAXIMUM_PATH_LENGTH - 1);
    base_directory[MAXIMUM_PATH_LENGTH - 1] = '\0';
    
    if (create_secure_directory_recursively(base_directory) == -1) {
        return -1;
    }
    
    char database_path[MAXIMUM_PATH_LENGTH];
    int written = snprintf(database_path, sizeof(database_path), "%s/%s", base_directory, database_name);
    if (written < 0 || written >= (int)sizeof(database_path)) {
        return -1;
    }
    
    if (create_secure_directory_recursively(database_path) == -1) {
        return -1;
    }
    
    printf("Database '%s' created successfully at %s\n", database_name, database_path);
    return 0;
}

char** list_all_secure_databases(int* database_count) {
    if (!database_count) return NULL;
    
    char base_directory[MAXIMUM_PATH_LENGTH];
    strncpy(base_directory, get_secure_sydb_base_directory_path(), MAXIMUM_PATH_LENGTH - 1);
    base_directory[MAXIMUM_PATH_LENGTH - 1] = '\0';
    
    DIR* directory = opendir(base_directory);
    if (!directory) {
        *database_count = 0;
        return NULL;
    }
    
    struct dirent* directory_entry;
    int count = 0;
    while ((directory_entry = readdir(directory)) != NULL) {
        if (directory_entry->d_type == DT_DIR && 
            strcmp(directory_entry->d_name, ".") != 0 && 
            strcmp(directory_entry->d_name, "..") != 0) {
            count++;
        }
    }
    rewinddir(directory);
    
    if (count == 0) {
        closedir(directory);
        *database_count = 0;
        return NULL;
    }
    
    char** databases = malloc(count * sizeof(char*));
    if (!databases) {
        closedir(directory);
        *database_count = 0;
        return NULL;
    }
    
    int index = 0;
    while ((directory_entry = readdir(directory)) != NULL && index < count) {
        if (directory_entry->d_type == DT_DIR && 
            strcmp(directory_entry->d_name, ".") != 0 && 
            strcmp(directory_entry->d_name, "..") != 0) {
            
            if (!validate_database_name(directory_entry->d_name)) {
                continue;
            }
            
            databases[index] = strdup(directory_entry->d_name);
            if (!databases[index]) {
                for (int i = 0; i < index; i++) {
                    free(databases[i]);
                }
                free(databases);
                closedir(directory);
                *database_count = 0;
                return NULL;
            }
            index++;
        }
    }
    closedir(directory);
    
    *database_count = count;
    return databases;
}

// ==================== SECURE COLLECTION OPERATIONS ====================

int create_secure_collection(const char* database_name, const char* collection_name, 
                            field_schema_t* fields, int field_count) {
    if (!validate_database_name(database_name) || !validate_collection_name(collection_name) || !fields || field_count <= 0) {
        fprintf(stderr, "Error: Invalid database, collection name, or fields\n");
        return -1;
    }
    
    if (!database_secure_exists(database_name)) {
        fprintf(stderr, "Database '%s' does not exist\n", database_name);
        return -1;
    }
    
    if (collection_secure_exists(database_name, collection_name)) {
        fprintf(stderr, "Collection '%s' already exists in database '%s'\n", collection_name, database_name);
        return -1;
    }
    
    char database_path[MAXIMUM_PATH_LENGTH];
    int written = snprintf(database_path, sizeof(database_path), "%s/%s", 
                          get_secure_sydb_base_directory_path(), database_name);
    if (written < 0 || written >= (int)sizeof(database_path)) {
        return -1;
    }
    
    char collection_path[MAXIMUM_PATH_LENGTH];
    written = snprintf(collection_path, sizeof(collection_path), "%s/%s", database_path, collection_name);
    if (written < 0 || written >= (int)sizeof(collection_path)) {
        return -1;
    }
    
    if (create_secure_directory_recursively(collection_path) == -1) {
        return -1;
    }
    
    char schema_file_path[MAXIMUM_PATH_LENGTH];
    written = snprintf(schema_file_path, sizeof(schema_file_path), "%s/schema.txt", collection_path);
    if (written < 0 || written >= (int)sizeof(schema_file_path)) {
        return -1;
    }
    
    char lock_file_path[MAXIMUM_PATH_LENGTH];
    written = snprintf(lock_file_path, sizeof(lock_file_path), "%s/.schema.lock", collection_path);
    if (written < 0 || written >= (int)sizeof(lock_file_path)) {
        return -1;
    }
    
    int lock_file_descriptor = acquire_secure_exclusive_lock(lock_file_path);
    if (lock_file_descriptor == -1) {
        return -1;
    }
    
    FILE* schema_file = fopen(schema_file_path, "w");
    if (!schema_file) {
        fprintf(stderr, "Error creating schema file: %s\n", strerror(errno));
        release_secure_exclusive_lock(lock_file_descriptor, lock_file_path);
        return -1;
    }
    
    for (int field_index = 0; field_index < field_count; field_index++) {
        fprintf(schema_file, "%s:%s:%s:%s\n", 
                fields[field_index].name, 
                convert_secure_field_type_to_string(fields[field_index].type),
                fields[field_index].required ? "required" : "optional",
                fields[field_index].indexed ? "indexed" : "unindexed");
    }
    
    fclose(schema_file);
    release_secure_exclusive_lock(lock_file_descriptor, lock_file_path);
    
    char data_file_path[MAXIMUM_PATH_LENGTH];
    written = snprintf(data_file_path, sizeof(data_file_path), "%s/data%s", collection_path, DATA_FILE_EXTENSION);
    if (written < 0 || written >= (int)sizeof(data_file_path)) {
        return -1;
    }
    
    FILE* data_file = fopen(data_file_path, "w+b");
    if (data_file) {
        initialize_secure_high_performance_data_file(data_file);
        fclose(data_file);
    }
    
    printf("Collection '%s' created successfully in database '%s'\n", 
           collection_name, database_name);
    return 0;
}

char** list_secure_collections_in_database(const char* database_name, int* collection_count) {
    if (!validate_database_name(database_name) || !collection_count) {
        *collection_count = 0;
        return NULL;
    }
    
    char database_path[MAXIMUM_PATH_LENGTH];
    int written = snprintf(database_path, sizeof(database_path), "%s/%s", 
                          get_secure_sydb_base_directory_path(), database_name);
    if (written < 0 || written >= (int)sizeof(database_path)) {
        *collection_count = 0;
        return NULL;
    }
    
    DIR* directory = opendir(database_path);
    if (!directory) {
        *collection_count = 0;
        return NULL;
    }
    
    struct dirent* directory_entry;
    int count = 0;
    while ((directory_entry = readdir(directory)) != NULL) {
        if (directory_entry->d_type == DT_DIR && 
            strcmp(directory_entry->d_name, ".") != 0 && 
            strcmp(directory_entry->d_name, "..") != 0) {
            count++;
        }
    }
    rewinddir(directory);
    
    if (count == 0) {
        closedir(directory);
        *collection_count = 0;
        return NULL;
    }
    
    char** collections = malloc(count * sizeof(char*));
    if (!collections) {
        closedir(directory);
        *collection_count = 0;
        return NULL;
    }
    
    int index = 0;
    while ((directory_entry = readdir(directory)) != NULL && index < count) {
        if (directory_entry->d_type == DT_DIR && 
            strcmp(directory_entry->d_name, ".") != 0 && 
            strcmp(directory_entry->d_name, "..") != 0) {
            
            if (!validate_collection_name(directory_entry->d_name)) {
                continue;
            }
            
            collections[index] = strdup(directory_entry->d_name);
            if (!collections[index]) {
                for (int i = 0; i < index; i++) {
                    free(collections[i]);
                }
                free(collections);
                closedir(directory);
                *collection_count = 0;
                return NULL;
            }
            index++;
        }
    }
    closedir(directory);
    
    *collection_count = count;
    return collections;
}

// ==================== SECURE HIGH-PERFORMANCE INSTANCE OPERATIONS ====================

char* build_secure_instance_json_from_fields_and_values(char** field_names, char** field_values, int field_count) {
    if (!field_names || !field_values || field_count <= 0 || field_count > MAXIMUM_FIELDS) {
        return NULL;
    }
    
    char* json_string = malloc(MAXIMUM_LINE_LENGTH);
    if (!json_string) return NULL;
    
    json_string[0] = '{';
    json_string[1] = '\0';
    
    int current_length = 1;
    
    for (int field_index = 0; field_index < field_count; field_index++) {
        if (!field_names[field_index] || !validate_field_name(field_names[field_index])) {
            continue;
        }
        
        if (field_index > 0) {
            if (current_length + 1 < MAXIMUM_LINE_LENGTH) {
                strcat(json_string, ",");
                current_length++;
            } else {
                free(json_string);
                return NULL;
            }
        }
        
        if (field_values[field_index] == NULL || strlen(field_values[field_index]) == 0) {
            continue;
        }
        
        char field_buffer[MAXIMUM_LINE_LENGTH / 2];
        if ((field_values[field_index][0] == '[' && field_values[field_index][strlen(field_values[field_index])-1] == ']') ||
            (field_values[field_index][0] == '{' && field_values[field_index][strlen(field_values[field_index])-1] == '}')) {
            int written = snprintf(field_buffer, sizeof(field_buffer), "\"%s\":%s", 
                                 field_names[field_index], field_values[field_index]);
            if (written < 0 || written >= (int)sizeof(field_buffer)) {
                continue;
            }
        } else {
            char* end_pointer;
            strtol(field_values[field_index], &end_pointer, 10);
            if (*end_pointer == '\0') {
                int written = snprintf(field_buffer, sizeof(field_buffer), "\"%s\":%s", 
                                     field_names[field_index], field_values[field_index]);
                if (written < 0 || written >= (int)sizeof(field_buffer)) {
                    continue;
                }
            } else {
                int written = snprintf(field_buffer, sizeof(field_buffer), "\"%s\":\"%s\"", 
                                     field_names[field_index], field_values[field_index]);
                if (written < 0 || written >= (int)sizeof(field_buffer)) {
                    continue;
                }
            }
        }
        
        if (current_length + strlen(field_buffer) < MAXIMUM_LINE_LENGTH - 1) {
            strcat(json_string, field_buffer);
            current_length += strlen(field_buffer);
        } else {
            free(json_string);
            return NULL;
        }
    }
    
    if (current_length + 1 < MAXIMUM_LINE_LENGTH) {
        strcat(json_string, "}");
    } else {
        free(json_string);
        return NULL;
    }
    
    return json_string;
}

int insert_secure_instance_into_collection(const char* database_name, const char* collection_name, char* instance_json) {
    if (!validate_database_name(database_name) || !validate_collection_name(collection_name) || !instance_json) {
        fprintf(stderr, "Error: Invalid database, collection name, or instance JSON\n");
        return -1;
    }
    
    if (!database_secure_exists(database_name) || !collection_secure_exists(database_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        return -1;
    }
    
    field_schema_t fields[MAXIMUM_FIELDS];
    int field_count = 0;
    if (load_secure_schema_from_file(database_name, collection_name, fields, &field_count) == -1) {
        return -1;
    }
    
    if (validate_secure_instance_against_schema(instance_json, fields, field_count) == -1) {
        fprintf(stderr, "Instance validation failed against schema\n");
        return -1;
    }
    
    char collection_path[MAXIMUM_PATH_LENGTH];
    int written = snprintf(collection_path, sizeof(collection_path), "%s/%s/%s", 
                          get_secure_sydb_base_directory_path(), database_name, collection_name);
    if (written < 0 || written >= (int)sizeof(collection_path)) {
        return -1;
    }
    
    char lock_file_path[MAXIMUM_PATH_LENGTH];
    written = snprintf(lock_file_path, sizeof(lock_file_path), "%s/.data.lock", collection_path);
    if (written < 0 || written >= (int)sizeof(lock_file_path)) {
        return -1;
    }
    
    int lock_file_descriptor = acquire_secure_exclusive_lock(lock_file_path);
    if (lock_file_descriptor == -1) {
        return -1;
    }
    
    char universally_unique_identifier[UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE];
    generate_secure_universally_unique_identifier(universally_unique_identifier);
    
    char complete_json[MAXIMUM_LINE_LENGTH];
    written = snprintf(complete_json, sizeof(complete_json), "{\"_id\":\"%s\",\"_created_at\":%ld,%s", 
                      universally_unique_identifier, time(NULL), instance_json + 1);
    if (written < 0 || written >= (int)sizeof(complete_json)) {
        release_secure_exclusive_lock(lock_file_descriptor, lock_file_path);
        return -1;
    }
    
    FILE* data_file = open_secure_data_file_with_optimizations(database_name, collection_name, "r+b");
    if (!data_file) {
        fprintf(stderr, "Error opening data file: %s\n", strerror(errno));
        release_secure_exclusive_lock(lock_file_descriptor, lock_file_path);
        return -1;
    }
    
    file_header_t file_header;
    if (read_secure_file_header_information(data_file, &file_header) == -1) {
        if (initialize_secure_high_performance_data_file(data_file) == -1) {
            fclose(data_file);
            release_secure_exclusive_lock(lock_file_descriptor, lock_file_path);
            return -1;
        }
        if (read_secure_file_header_information(data_file, &file_header) == -1) {
            fclose(data_file);
            release_secure_exclusive_lock(lock_file_descriptor, lock_file_path);
            return -1;
        }
    }
    
    size_t data_length = strlen(complete_json);
    size_t total_record_size = sizeof(record_header_t) + data_length + 1;
    
    if (file_header.free_offset + total_record_size > file_header.file_size) {
        file_header.file_size = file_header.free_offset + total_record_size + 1024;
        if (write_secure_file_header_information(data_file, &file_header) == -1) {
            fclose(data_file);
            release_secure_exclusive_lock(lock_file_descriptor, lock_file_path);
            return -1;
        }
    }
    
    if (fseek(data_file, file_header.free_offset, SEEK_SET) != 0) {
        fclose(data_file);
        release_secure_exclusive_lock(lock_file_descriptor, lock_file_path);
        return -1;
    }
    
    record_header_t record_header = {
        .data_size = data_length,
        .timestamp = time(NULL),
        .flags = 0,
        .data_checksum = compute_crc_32_checksum(complete_json, data_length),
        .field_count = 0
    };
    strncpy(record_header.universally_unique_identifier, universally_unique_identifier, UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE - 1);
    record_header.universally_unique_identifier[UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE - 1] = '\0';
    memset(record_header.reserved, 0, sizeof(record_header.reserved));
    
    if (fwrite(&record_header, sizeof(record_header_t), 1, data_file) != 1) {
        fclose(data_file);
        release_secure_exclusive_lock(lock_file_descriptor, lock_file_path);
        return -1;
    }
    if (fwrite(complete_json, data_length + 1, 1, data_file) != 1) {
        fclose(data_file);
        release_secure_exclusive_lock(lock_file_descriptor, lock_file_path);
        return -1;
    }
    
    file_header.record_count++;
    file_header.free_offset += total_record_size;
    
    if (write_secure_file_header_information(data_file, &file_header) == -1) {
        fclose(data_file);
        release_secure_exclusive_lock(lock_file_descriptor, lock_file_path);
        return -1;
    }
    
    fclose(data_file);
    release_secure_exclusive_lock(lock_file_descriptor, lock_file_path);
    
    printf("Instance inserted successfully with ID: %s\n", universally_unique_identifier);
    return 0;
}

// ==================== SECURE RECORD ITERATOR FOR HIGH-PERFORMANCE SCANNING ====================

record_iterator_t* create_secure_record_iterator(FILE* data_file, lru_cache_t* cache) {
    if (!data_file) return NULL;
    
    file_header_t file_header;
    if (read_secure_file_header_information(data_file, &file_header) == -1) return NULL;
    
    record_iterator_t* iterator = secure_malloc(sizeof(record_iterator_t));
    if (!iterator) return NULL;
    
    iterator->data_file = data_file;
    iterator->current_offset = sizeof(file_header_t);
    iterator->records_processed = 0;
    iterator->cache = cache;
    
    return iterator;
}

void free_secure_record_iterator(record_iterator_t* iterator) {
    secure_free((void**)&iterator);
}

int read_secure_next_record_from_iterator(record_iterator_t* iterator, record_header_t* record_header, char** json_data) {
    if (!iterator || !record_header || !json_data) return -1;
    
    file_header_t file_header;
    if (read_secure_file_header_information(iterator->data_file, &file_header) == -1) return -1;
    
    if (iterator->records_processed >= file_header.record_count) return 0;
    
    if (fseek(iterator->data_file, iterator->current_offset, SEEK_SET) != 0) return -1;
    
    if (fread(record_header, sizeof(record_header_t), 1, iterator->data_file) != 1) return -1;
    
    if (record_header->data_size >= MAXIMUM_LINE_LENGTH) {
        return -1;
    }
    
    *json_data = malloc(record_header->data_size + 1);
    if (!*json_data) return -1;
    
    if (fread(*json_data, record_header->data_size + 1, 1, iterator->data_file) != 1) {
        free(*json_data);
        return -1;
    }
    
    uint32_t computed_checksum = compute_crc_32_checksum(*json_data, record_header->data_size);
    if (computed_checksum != record_header->data_checksum) {
        free(*json_data);
        return -1;
    }
    
    iterator->current_offset += sizeof(record_header_t) + record_header->data_size + 1;
    iterator->records_processed++;
    
    return 1;
}

// ==================== SECURE QUERY OPERATIONS ====================

char** find_secure_instances_with_query(const char* database_name, const char* collection_name, const char* query, int* result_count) {
    if (!validate_database_name(database_name) || !validate_collection_name(collection_name) || !result_count) {
        *result_count = 0;
        return NULL;
    }
    
    if (!database_secure_exists(database_name) || !collection_secure_exists(database_name, collection_name)) {
        fprintf(stderr, "Database or collection does not exist\n");
        *result_count = 0;
        return NULL;
    }
    
    FILE* data_file = open_secure_data_file_with_optimizations(database_name, collection_name, "rb");
    if (!data_file) {
        *result_count = 0;
        return NULL;
    }
    
    record_iterator_t* iterator = create_secure_record_iterator(data_file, NULL);
    if (!iterator) {
        fclose(data_file);
        *result_count = 0;
        return NULL;
    }
    
    record_header_t record_header;
    char* json_data;
    int match_count = 0;
    
    while (read_secure_next_record_from_iterator(iterator, &record_header, &json_data) == 1) {
        if (json_matches_query_conditions(json_data, query)) {
            match_count++;
        }
        free(json_data);
    }
    
    free_secure_record_iterator(iterator);
    
    if (match_count == 0) {
        fclose(data_file);
        *result_count = 0;
        return NULL;
    }
    
    iterator = create_secure_record_iterator(data_file, NULL);
    char** results = malloc(match_count * sizeof(char*));
    if (!results) {
        free_secure_record_iterator(iterator);
        fclose(data_file);
        *result_count = 0;
        return NULL;
    }
    
    int current_index = 0;
    while (read_secure_next_record_from_iterator(iterator, &record_header, &json_data) == 1 && current_index < match_count) {
        if (json_matches_query_conditions(json_data, query)) {
            results[current_index] = strdup(json_data);
            if (!results[current_index]) {
                for (int i = 0; i < current_index; i++) {
                    free(results[i]);
                }
                free(results);
                free_secure_record_iterator(iterator);
                fclose(data_file);
                *result_count = 0;
                return NULL;
            }
            current_index++;
        }
        free(json_data);
    }
    
    free_secure_record_iterator(iterator);
    fclose(data_file);
    *result_count = current_index;
    return results;
}

char** list_all_secure_instances_in_collection(const char* database_name, const char* collection_name, int* instance_count) {
    if (!validate_database_name(database_name) || !validate_collection_name(collection_name) || !instance_count) {
        *instance_count = 0;
        return NULL;
    }
    
    FILE* data_file = open_secure_data_file_with_optimizations(database_name, collection_name, "rb");
    if (!data_file) {
        *instance_count = 0;
        return NULL;
    }
    
    file_header_t file_header;
    if (read_secure_file_header_information(data_file, &file_header) == -1) {
        fclose(data_file);
        *instance_count = 0;
        return NULL;
    }
    
    if (file_header.record_count == 0) {
        fclose(data_file);
        *instance_count = 0;
        return NULL;
    }
    
    char** instances = malloc(file_header.record_count * sizeof(char*));
    if (!instances) {
        fclose(data_file);
        *instance_count = 0;
        return NULL;
    }
    
    record_iterator_t* iterator = create_secure_record_iterator(data_file, NULL);
    if (!iterator) {
        free(instances);
        fclose(data_file);
        *instance_count = 0;
        return NULL;
    }
    
    record_header_t record_header;
    char* json_data;
    int current_index = 0;
    
    while (read_secure_next_record_from_iterator(iterator, &record_header, &json_data) == 1 && current_index < file_header.record_count) {
        instances[current_index] = strdup(json_data);
        if (!instances[current_index]) {
            for (int i = 0; i < current_index; i++) {
                free(instances[i]);
            }
            free(instances);
            free_secure_record_iterator(iterator);
            fclose(data_file);
            *instance_count = 0;
            return NULL;
        }
        free(json_data);
        current_index++;
    }
    
    free_secure_record_iterator(iterator);
    fclose(data_file);
    *instance_count = current_index;
    return instances;
}

// ==================== SECURE COMMAND LINE INTERFACE ====================

void print_secure_usage_information() {
    printf("Usage:\n");
    printf("  sydb create <database_name>\n");
    printf("  sydb create <database_name> <collection_name> --schema --<field>-<type>[-req][-idx] ...\n");
    printf("  sydb create <database_name> <collection_name> --insert-one --<field>-\"<value>\" ...\n");
    printf("  sydb update <database_name> <collection_name> --where \"<query>\" --set --<field>-\"<value>\" ...\n");
    printf("  sydb delete <database_name> <collection_name> --where \"<query>\"\n");
    printf("  sydb find <database_name> <collection_name> --where \"<query>\"\n");
    printf("  sydb schema <database_name> <collection_name>\n");
    printf("  sydb list\n");
    printf("  sydb list <database_name>\n");
    printf("  sydb list <database_name> <collection_name>\n");
    printf("  sydb --server [port]          # Start HTTP server\n");
    printf("  sydb --routes                 # Show all HTTP API routes and schemas\n");
    printf("\nField types: string, int, float, bool, array, object\n");
    printf("Add -req for required fields\n");
    printf("Add -idx for indexed fields (improves query performance)\n");
    printf("Query format: field:value,field2:value2 (multiple conditions supported)\n");
    printf("Server mode: Starts HTTP server on specified port (default: 8080)\n");
}

int parse_secure_insert_data_from_arguments(int argument_count, char* argument_values[], int start_index, 
                                           char** field_names, char** field_values, int* field_count) {
    if (!argument_values || !field_names || !field_values || !field_count || argument_count <= start_index) {
        return -1;
    }
    
    *field_count = 0;
    
    for (int argument_index = start_index; argument_index < argument_count && *field_count < MAXIMUM_FIELDS; argument_index++) {
        char* field_specification = argument_values[argument_index];
        if (!field_specification || strncmp(field_specification, "--", 2) != 0) continue;
        
        field_specification += 2;
        
        char* value_start = strchr(field_specification, '-');
        if (!value_start) {
            continue;
        }
        
        *value_start = '\0';
        char* field_value = value_start + 1;
        
        if (!validate_field_name(field_specification)) {
            continue;
        }
        
        if (strlen(field_value) == 0) {
            field_names[*field_count] = strdup(field_specification);
            field_values[*field_count] = strdup("");
        } else {
            if (field_value[0] == '"' && field_value[strlen(field_value)-1] == '"') {
                field_value[strlen(field_value)-1] = '\0';
                field_value++;
            }
            
            if (strlen(field_value) >= MAXIMUM_LINE_LENGTH / 2) {
                continue;
            }
            
            field_names[*field_count] = strdup(field_specification);
            field_values[*field_count] = strdup(field_value);
        }
        
        if (!field_names[*field_count] || !field_values[*field_count]) {
            for (int field_index = 0; field_index < *field_count; field_index++) {
                free(field_names[field_index]);
                free(field_values[field_index]);
            }
            return -1;
        }
        
        (*field_count)++;
    }
    
    return 0;
}

int main(int argument_count, char* argument_values[]) {
    if (argument_count < 2) {
        print_secure_usage_information();
        return 1;
    }
    
    if (strcmp(argument_values[1], "--routes") == 0) {
        display_http_routes();
        return 0;
    }
    // Check for server mode
    if (strcmp(argument_values[1], "--server") == 0) {
        int port = HTTP_SERVER_PORT;
        
        if (argument_count > 2) {
            port = atoi(argument_values[2]);
            if (port <= 0 || port > 65535) {
                fprintf(stderr, "Error: Invalid port number %s\n", argument_values[2]);
                return 1;
            }
        }
        
        // Setup signal handlers for graceful shutdown
        signal(SIGINT, http_server_handle_signal);
        signal(SIGTERM, http_server_handle_signal);
        
        create_secure_directory_recursively(get_secure_sydb_base_directory_path());
        
        printf("Starting SYDB HTTP Server on port %d...\n", port);
        printf("Press Ctrl+C to stop the server\n");
        
        if (http_server_start(port) == 0) {
            // Server is running in background threads
            // Wait for shutdown signal
            pause(); // Wait for signal
        } else {
            fprintf(stderr, "Failed to start HTTP server\n");
            return 1;
        }
        
        return 0;
    }
    
    create_secure_directory_recursively(get_secure_sydb_base_directory_path());
    
    if (strcmp(argument_values[1], "create") == 0) {
        if (argument_count < 3) {
            fprintf(stderr, "Error: Missing database name\n");
            print_secure_usage_information();
            return 1;
        }
        
        if (!validate_database_name(argument_values[2])) {
            fprintf(stderr, "Error: Invalid database name '%s'\n", argument_values[2]);
            return 1;
        }
        
        if (argument_count == 3) {
            return create_secure_database(argument_values[2]);
        }
        else if (argument_count >= 5) {
            if (!validate_collection_name(argument_values[3])) {
                fprintf(stderr, "Error: Invalid collection name '%s'\n", argument_values[3]);
                return 1;
            }
            
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
                    fprintf(stderr, "Error: Invalid syntax. Use: sydb create <database> <collection> --schema ...\n");
                    print_secure_usage_information();
                    return 1;
                }
                
                if (argument_count < 6) {
                    fprintf(stderr, "Error: Missing schema fields\n");
                    print_secure_usage_information();
                    return 1;
                }
                
                field_schema_t fields[MAXIMUM_FIELDS];
                int field_count = 0;
                if (parse_secure_schema_fields_from_arguments(argument_count, argument_values, schema_flag_index + 1, 
                                                              fields, &field_count) == -1) {
                    return 1;
                }
                
                if (field_count == 0) {
                    fprintf(stderr, "Error: No valid schema fields provided\n");
                    return 1;
                }
                
                return create_secure_collection(argument_values[2], argument_values[3], fields, field_count);
            }
            else if (insert_flag_index != -1) {
                if (insert_flag_index != 4) {
                    fprintf(stderr, "Error: Invalid syntax. Use: sydb create <database> <collection> --insert-one ...\n");
                    print_secure_usage_information();
                    return 1;
                }
                
                if (argument_count < 6) {
                    fprintf(stderr, "Error: Missing insert data\n");
                    print_secure_usage_information();
                    return 1;
                }
                
                char* field_names[MAXIMUM_FIELDS];
                char* field_values[MAXIMUM_FIELDS];
                int field_count = 0;
                
                if (parse_secure_insert_data_from_arguments(argument_count, argument_values, insert_flag_index + 1, 
                                                           field_names, field_values, &field_count) == -1) {
                    fprintf(stderr, "Error: Failed to parse insert data\n");
                    return 1;
                }
                
                if (field_count == 0) {
                    fprintf(stderr, "Error: No valid insert fields provided\n");
                    return 1;
                }
                
                char* instance_json = build_secure_instance_json_from_fields_and_values(field_names, field_values, field_count);
                if (!instance_json) {
                    fprintf(stderr, "Error: Failed to build instance JSON\n");
                    for (int field_index = 0; field_index < field_count; field_index++) {
                        free(field_names[field_index]);
                        free(field_values[field_index]);
                    }
                    return 1;
                }
                
                int result = insert_secure_instance_into_collection(argument_values[2], argument_values[3], instance_json);
                
                free(instance_json);
                for (int field_index = 0; field_index < field_count; field_index++) {
                    free(field_names[field_index]);
                    free(field_values[field_index]);
                }
                
                return result;
            }
            else {
                fprintf(stderr, "Error: Missing --schema or --insert-one flag\n");
                print_secure_usage_information();
                return 1;
            }
        }
        else {
            fprintf(stderr, "Error: Invalid create operation\n");
            print_secure_usage_information();
            return 1;
        }
    }
    else if (strcmp(argument_values[1], "find") == 0) {
        if (argument_count < 6 || strcmp(argument_values[4], "--where") != 0) {
            fprintf(stderr, "Error: Invalid find syntax. Use: sydb find <database> <collection> --where \"query\"\n");
            print_secure_usage_information();
            return 1;
        }
        
        if (!validate_database_name(argument_values[2]) || !validate_collection_name(argument_values[3])) {
            fprintf(stderr, "Error: Invalid database or collection name\n");
            return 1;
        }
        
        if (!database_secure_exists(argument_values[2]) || !collection_secure_exists(argument_values[2], argument_values[3])) {
            fprintf(stderr, "Error: Database or collection does not exist\n");
            return 1;
        }
        
        int result_count;
        char** results = find_secure_instances_with_query(argument_values[2], argument_values[3], argument_values[5], &result_count);
        if (result_count > 0) {
            for (int result_index = 0; result_index < result_count; result_index++) {
                printf("%s\n", results[result_index]);
                free(results[result_index]);
            }
            free(results);
            return 0;
        } else {
            // Empty result is not an error - return success
            return 0;
        }
    }
    else if (strcmp(argument_values[1], "schema") == 0) {
        if (argument_count < 4) {
            fprintf(stderr, "Error: Missing database or collection name\n");
            print_secure_usage_information();
            return 1;
        }
        
        if (!validate_database_name(argument_values[2]) || !validate_collection_name(argument_values[3])) {
            fprintf(stderr, "Error: Invalid database or collection name\n");
            return 1;
        }
        
        if (!database_secure_exists(argument_values[2]) || !collection_secure_exists(argument_values[2], argument_values[3])) {
            fprintf(stderr, "Error: Database or collection does not exist\n");
            return 1;
        }
        
        print_secure_collection_schema(argument_values[2], argument_values[3]);
        return 0;
    }
    else if (strcmp(argument_values[1], "list") == 0) {
        if (argument_count == 2) {
            int database_count;
            char** databases = list_all_secure_databases(&database_count);
            if (database_count == 0) {
                printf("No databases found\n");
            } else {
                for (int database_index = 0; database_index < database_count; database_index++) {
                    printf("%s\n", databases[database_index]);
                    free(databases[database_index]);
                }
                free(databases);
            }
            return 0;
        }
        else if (argument_count == 3) {
            if (!validate_database_name(argument_values[2])) {
                fprintf(stderr, "Error: Invalid database name '%s'\n", argument_values[2]);
                return 1;
            }
            
            if (!database_secure_exists(argument_values[2])) {
                fprintf(stderr, "Error: Database '%s' does not exist\n", argument_values[2]);
                return 1;
            }
            
            int collection_count;
            char** collections = list_secure_collections_in_database(argument_values[2], &collection_count);
            if (collection_count == 0) {
                printf("No collections found in database '%s'\n", argument_values[2]);
            } else {
                for (int collection_index = 0; collection_index < collection_count; collection_index++) {
                    printf("%s\n", collections[collection_index]);
                    free(collections[collection_index]);
                }
                free(collections);
            }
            return 0;
        }
        else if (argument_count == 4) {
            if (!validate_database_name(argument_values[2]) || !validate_collection_name(argument_values[3])) {
                fprintf(stderr, "Error: Invalid database or collection name\n");
                return 1;
            }
            
            if (!database_secure_exists(argument_values[2]) || !collection_secure_exists(argument_values[2], argument_values[3])) {
                fprintf(stderr, "Error: Database or collection does not exist\n");
                return 1;
            }
            
            int instance_count;
            char** instances = list_all_secure_instances_in_collection(argument_values[2], argument_values[3], &instance_count);
            if (instance_count == 0) {
                printf("No instances found in collection '%s'\n", argument_values[3]);
            } else {
                for (int instance_index = 0; instance_index < instance_count; instance_index++) {
                    printf("%s\n", instances[instance_index]);
                    free(instances[instance_index]);
                }
                free(instances);
            }
            return 0;
        }
        else {
            fprintf(stderr, "Error: Invalid list operation\n");
            print_secure_usage_information();
            return 1;
        }
    }
    else {
        fprintf(stderr, "Error: Unknown command '%s'\n", argument_values[1]);
        print_secure_usage_information();
        return 1;
    }
    
    return 0;
}
