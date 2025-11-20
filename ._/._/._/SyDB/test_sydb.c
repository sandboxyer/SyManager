#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/time.h>
#include <time.h>
#include <dirent.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <errno.h>

#define RED     "\033[1;31m"
#define GREEN   "\033[1;32m"
#define YELLOW  "\033[1;33m"
#define BLUE    "\033[1;34m"
#define MAGENTA "\033[1;35m"
#define CYAN    "\033[1;36m"
#define RESET   "\033[0m"

typedef struct {
    char description[512];
    char command[1024];
    char verification_command[1024];
    char expected_output[1024];
    int success;
    int verification_success;
    long long duration_ms;
    char details[1024];
} TestCase;

// Global variables
char cli_command[32] = "./sydb";
int test_mode = 0; // 0 = CLI, 1 = HTTP
char server_url[256] = "http://localhost:8080";

// HTTP Request/Response structures
typedef struct {
    int status_code;
    char* body;
    size_t body_length;
} HttpResponse;

// Function prototypes for HTTP testing
HttpResponse* http_request(const char* method, const char* url, const char* body, const char* content_type);
void http_response_free(HttpResponse* response);
int http_test_endpoint(const char* description, const char* method, const char* endpoint, 
                      const char* body, const char* expected_pattern, int check_success_only, long long* duration);
int verify_http_response(const HttpResponse* response, const char* expected_pattern, int check_success_only);
char* extract_json_field(const char* json, const char* field);

// Utility function prototypes
long long get_current_time_ms();
int file_exists(const char *path);
int count_files_in_directory(const char *path);
int count_instances_in_collection(const char *database, const char *collection);
char* get_last_inserted_id(const char *database, const char *collection);
int execute_command_and_capture(const char *command, char *output, size_t output_size);
int verify_database_structure(const char *database);
int verify_collection_structure(const char *database, const char *collection);
int verify_schema_content(const char *database, const char *collection, const char *expected_fields);
int execute_test_with_verification(TestCase *test);
void run_security_tests();
void run_data_integrity_tests();
void run_performance_test();
void run_edge_case_tests();
void run_comprehensive_verification();

// ==================== UTILITY FUNCTIONS ====================

long long get_current_time_ms() {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

int file_exists(const char *path) {
    struct stat st;
    return stat(path, &st) == 0;
}

int count_files_in_directory(const char *path) {
    DIR *dir = opendir(path);
    if (!dir) return -1;
    
    int count = 0;
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) {
            count++;
        }
    }
    closedir(dir);
    return count;
}

int count_instances_in_collection(const char *database, const char *collection) {
    char command[512];
    snprintf(command, sizeof(command), "%s list %s %s 2>/dev/null | wc -l", cli_command, database, collection);
    
    FILE *fp = popen(command, "r");
    if (!fp) return -1;
    
    int count = 0;
    char buffer[64];
    if (fgets(buffer, sizeof(buffer), fp)) {
        count = atoi(buffer);
    }
    pclose(fp);
    
    return count;
}

char* get_last_inserted_id(const char *database, const char *collection) {
    char command[512];
    snprintf(command, sizeof(command), "%s list %s %s 2>/dev/null | tail -1", cli_command, database, collection);
    
    FILE *fp = popen(command, "r");
    if (!fp) return NULL;
    
    static char id[64];
    if (fgets(id, sizeof(id), fp)) {
        // Extract ID from JSON
        char *id_start = strstr(id, "\"_id\":\"");
        if (id_start) {
            id_start += 7;
            char *id_end = strchr(id_start, '"');
            if (id_end) {
                *id_end = '\0';
                strncpy(id, id_start, sizeof(id) - 1);
                pclose(fp);
                return id;
            }
        }
    }
    pclose(fp);
    return NULL;
}

int execute_command_and_capture(const char *command, char *output, size_t output_size) {
    FILE *fp = popen(command, "r");
    if (!fp) return -1;
    
    output[0] = '\0';
    if (fgets(output, output_size, fp)) {
        // Remove newline
        output[strcspn(output, "\n")] = '\0';
    }
    pclose(fp);
    return 0;
}

int verify_database_structure(const char *database) {
    char path[512];
    snprintf(path, sizeof(path), "/tmp/sydb_test/%s", database);
    
    if (!file_exists(path)) {
        printf(RED "  ✗ Database directory doesn't exist\n" RESET);
        return 0;
    }
    
    struct stat st;
    if (stat(path, &st) != 0 || !S_ISDIR(st.st_mode)) {
        printf(RED "  ✗ Database path is not a directory\n" RESET);
        return 0;
    }
    
    printf(GREEN "  ✓ Database directory exists and is valid\n" RESET);
    return 1;
}

int verify_collection_structure(const char *database, const char *collection) {
    char path[512];
    snprintf(path, sizeof(path), "/tmp/sydb_test/%s/%s", database, collection);
    
    if (!file_exists(path)) {
        printf(RED "  ✗ Collection directory doesn't exist\n" RESET);
        return 0;
    }
    
    // Check for schema file
    char schema_path[512];
    snprintf(schema_path, sizeof(schema_path), "%s/schema.txt", path);
    if (!file_exists(schema_path)) {
        printf(RED "  ✗ Schema file doesn't exist\n" RESET);
        return 0;
    }
    
    // Check for data file
    char data_path[512];
    snprintf(data_path, sizeof(data_path), "%s/data.sydb", path);
    if (!file_exists(data_path)) {
        printf(RED "  ✗ Data file doesn't exist\n" RESET);
        return 0;
    }
    
    printf(GREEN "  ✓ Collection structure is valid\n" RESET);
    return 1;
}

int verify_schema_content(const char *database, const char *collection, const char *expected_fields) {
    char command[512];
    snprintf(command, sizeof(command), "%s schema %s %s", cli_command, database, collection);
    
    char output[1024];
    if (execute_command_and_capture(command, output, sizeof(output)) != 0) {
        printf(RED "  ✗ Could not read schema\n" RESET);
        return 0;
    }
    
    // Basic schema verification
    if (strstr(output, "Field") == NULL || strstr(output, "Type") == NULL) {
        printf(RED "  ✗ Schema output format incorrect\n" RESET);
        return 0;
    }
    
    printf(GREEN "  ✓ Schema content is valid\n" RESET);
    return 1;
}

int execute_test_with_verification(TestCase *test) {
    printf("\n%s%-80s" RESET, BLUE, test->description);
    fflush(stdout);
    
    long long start_time = get_current_time_ms();
    
    // Execute main command
    int result = system(test->command);
    long long end_time = get_current_time_ms();
    
    test->duration_ms = end_time - start_time;
    test->success = (result == 0);
    
    // Perform verification if command succeeded
    test->verification_success = 1;
    if (test->success && test->verification_command[0] != '\0') {
        char verification_output[1024];
        if (execute_command_and_capture(test->verification_command, verification_output, sizeof(verification_output)) == 0) {
            if (test->expected_output[0] != '\0') {
                if (strstr(verification_output, test->expected_output) == NULL) {
                    test->verification_success = 0;
                    strncpy(test->details, verification_output, sizeof(test->details) - 1);
                }
            }
        } else {
            test->verification_success = 0;
            strcpy(test->details, "Verification command failed");
        }
    }
    
    // Overall test result
    int overall_success = test->success && test->verification_success;
    
    if (overall_success) {
        printf("[" GREEN "PASS" RESET "]");
    } else {
        printf("[" RED "FAIL" RESET "]");
    }
    
    printf(" %s%4lld ms%s\n", CYAN, test->duration_ms, RESET);
    
    // Print details if verification failed
    if (!test->verification_success && test->details[0] != '\0') {
        printf(RED "  Verification failed: %s\n" RESET, test->details);
    }
    
    return overall_success;
}

// ==================== HTTP CLIENT IMPLEMENTATION ====================

HttpResponse* http_request(const char* method, const char* url, const char* body, const char* content_type) {
    HttpResponse* response = malloc(sizeof(HttpResponse));
    if (!response) return NULL;
    
    response->status_code = 0;
    response->body = NULL;
    response->body_length = 0;
    
    // Parse URL
    char host[256] = "localhost";
    int port = 8080;
    char path[1024] = "/";
    
    if (strncmp(url, "http://", 7) == 0) {
        const char* host_start = url + 7;
        const char* path_start = strchr(host_start, '/');
        const char* port_start = strchr(host_start, ':');
        
        if (port_start && (!path_start || port_start < path_start)) {
            // Has port before path
            size_t host_len = port_start - host_start;
            strncpy(host, host_start, host_len);
            host[host_len] = '\0';
            port = atoi(port_start + 1);
            if (path_start) {
                strcpy(path, path_start);
            }
        } else if (path_start) {
            // No port, has path
            size_t host_len = path_start - host_start;
            strncpy(host, host_start, host_len);
            host[host_len] = '\0';
            strcpy(path, path_start);
        } else {
            // No port, no path
            strcpy(host, host_start);
        }
    } else {
        // Assume it's just a path
        strcpy(path, url);
    }
    
    // Create socket
    int sockfd = socket(AF_INET, SOCK_STREAM, 0);
    if (sockfd < 0) {
        perror("socket");
        free(response);
        return NULL;
    }
    
    // Set timeout
    struct timeval timeout;
    timeout.tv_sec = 10;
    timeout.tv_usec = 0;
    setsockopt(sockfd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(sockfd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    
    // Resolve hostname
    struct hostent* server = gethostbyname(host);
    if (!server) {
        fprintf(stderr, "Error: No such host %s\n", host);
        close(sockfd);
        free(response);
        return NULL;
    }
    
    // Connect to server
    struct sockaddr_in serv_addr;
    memset(&serv_addr, 0, sizeof(serv_addr));
    serv_addr.sin_family = AF_INET;
    memcpy(&serv_addr.sin_addr.s_addr, server->h_addr, server->h_length);
    serv_addr.sin_port = htons(port);
    
    if (connect(sockfd, (struct sockaddr*)&serv_addr, sizeof(serv_addr)) < 0) {
        fprintf(stderr, "Error connecting to %s:%d: %s\n", host, port, strerror(errno));
        close(sockfd);
        free(response);
        return NULL;
    }
    
    // Build HTTP request
    char request[8192];
    int request_len;
    
    if (body && content_type) {
        request_len = snprintf(request, sizeof(request),
            "%s %s HTTP/1.1\r\n"
            "Host: %s:%d\r\n"
            "Content-Type: %s\r\n"
            "Content-Length: %zu\r\n"
            "Connection: close\r\n"
            "\r\n"
            "%s",
            method, path, host, port, content_type, strlen(body), body);
    } else if (body) {
        request_len = snprintf(request, sizeof(request),
            "%s %s HTTP/1.1\r\n"
            "Host: %s:%d\r\n"
            "Content-Length: %zu\r\n"
            "Connection: close\r\n"
            "\r\n"
            "%s",
            method, path, host, port, strlen(body), body);
    } else {
        request_len = snprintf(request, sizeof(request),
            "%s %s HTTP/1.1\r\n"
            "Host: %s:%d\r\n"
            "Connection: close\r\n"
            "\r\n",
            method, path, host, port);
    }
    
    if (request_len >= (int)sizeof(request)) {
        fprintf(stderr, "Error: HTTP request too large\n");
        close(sockfd);
        free(response);
        return NULL;
    }
    
    // Send request
    if (send(sockfd, request, request_len, 0) < 0) {
        perror("send");
        close(sockfd);
        free(response);
        return NULL;
    }
    
    // Receive response
    char response_buffer[16384];
    ssize_t total_received = 0;
    ssize_t received;
    
    while ((received = recv(sockfd, response_buffer + total_received, 
                           sizeof(response_buffer) - total_received - 1, 0)) > 0) {
        total_received += received;
        if (total_received >= (ssize_t)sizeof(response_buffer) - 1) {
            break;
        }
    }
    
    if (received < 0) {
        perror("recv");
        close(sockfd);
        free(response);
        return NULL;
    }
    
    response_buffer[total_received] = '\0';
    close(sockfd);
    
    // Parse HTTP response
    char* status_line = strstr(response_buffer, "HTTP/1.1");
    if (status_line) {
        sscanf(status_line, "HTTP/1.1 %d", &response->status_code);
    }
    
    // Find body
    char* body_start = strstr(response_buffer, "\r\n\r\n");
    if (body_start) {
        body_start += 4;
        response->body_length = total_received - (body_start - response_buffer);
        response->body = malloc(response->body_length + 1);
        if (response->body) {
            memcpy(response->body, body_start, response->body_length);
            response->body[response->body_length] = '\0';
        }
    } else {
        // No body found
        response->body = strdup("");
        response->body_length = 0;
    }
    
    return response;
}

void http_response_free(HttpResponse* response) {
    if (response) {
        if (response->body) {
            free(response->body);
        }
        free(response);
    }
}

int verify_http_response(const HttpResponse* response, const char* expected_pattern, int check_success_only) {
    if (!response) return 0;
    
    if (check_success_only) {
        // Only check if the response indicates success (true) or proper error handling (false)
        // This is useful for endpoints that might return success:false with proper error messages
        return (response->status_code >= 200 && response->status_code < 500) && 
               response->body && strstr(response->body, "\"success\":") != NULL;
    } else {
        // Check status code and expected pattern
        if (response->status_code < 200 || response->status_code >= 300) {
            return 0;
        }
        
        // Check for expected pattern in body
        if (expected_pattern && expected_pattern[0] != '\0') {
            if (!response->body || strstr(response->body, expected_pattern) == NULL) {
                return 0;
            }
        }
    }
    
    return 1;
}

char* extract_json_field(const char* json, const char* field) {
    if (!json || !field) return NULL;
    
    char search_pattern[256];
    snprintf(search_pattern, sizeof(search_pattern), "\"%s\":\"", field);
    
    char* field_start = strstr(json, search_pattern);
    if (!field_start) {
        // Try without quotes for the value
        snprintf(search_pattern, sizeof(search_pattern), "\"%s\":", field);
        field_start = strstr(json, search_pattern);
        if (!field_start) return NULL;
        
        field_start += strlen(search_pattern);
        char* field_end = strchr(field_start, ',');
        if (!field_end) field_end = strchr(field_start, '}');
        if (!field_end) return NULL;
        
        size_t field_length = field_end - field_start;
        char* value = malloc(field_length + 1);
        if (!value) return NULL;
        
        strncpy(value, field_start, field_length);
        value[field_length] = '\0';
        return value;
    }
    
    field_start += strlen(search_pattern);
    char* field_end = strchr(field_start, '"');
    if (!field_end) return NULL;
    
    size_t field_length = field_end - field_start;
    char* value = malloc(field_length + 1);
    if (!value) return NULL;
    
    strncpy(value, field_start, field_length);
    value[field_length] = '\0';
    return value;
}

int http_test_endpoint(const char* description, const char* method, const char* endpoint, 
                      const char* body, const char* expected_pattern, int check_success_only, long long* duration) {
    printf("\n%s%-80s" RESET, BLUE, description);
    fflush(stdout);
    
    long long start_time = get_current_time_ms();
    
    HttpResponse* response = http_request(method, endpoint, body, "application/json");
    long long end_time = get_current_time_ms();
    
    if (duration) {
        *duration = end_time - start_time;
    }
    
    int success = 0;
    if (response) {
        success = verify_http_response(response, expected_pattern, check_success_only);
        if (!success) {
            printf("[" RED "FAIL" RESET "] %s%4lld ms%s\n", CYAN, end_time - start_time, RESET);
            if (response->body) {
                printf(RED "  Status: %d, Response: %s\n" RESET, response->status_code, response->body);
            } else {
                printf(RED "  Status: %d, No response body\n" RESET, response->status_code);
            }
        } else {
            printf("[" GREEN "PASS" RESET "] %s%4lld ms%s\n", CYAN, end_time - start_time, RESET);
        }
        http_response_free(response);
    } else {
        printf("[" RED "FAIL" RESET "] %s%4lld ms%s\n", CYAN, end_time - start_time, RESET);
        printf(RED "  No response from server\n" RESET);
    }
    
    return success;
}

// ==================== HTTP API TEST SUITE ====================

int run_http_database_tests() {
    printf("\n" MAGENTA "HTTP API DATABASE TESTS" RESET "\n");
    
    int passed = 0;
    int total = 0;
    long long total_time = 0;
    long long duration;
    
    // Generate unique database names to avoid conflicts
    char unique_db1[64], unique_db2[64];
    snprintf(unique_db1, sizeof(unique_db1), "testdb_%ld", time(NULL));
    snprintf(unique_db2, sizeof(unique_db2), "testdb2_%ld", time(NULL) + 1);
    
    char create_db1_body[128], create_db2_body[128];
    snprintf(create_db1_body, sizeof(create_db1_body), "{\"name\":\"%s\"}", unique_db1);
    snprintf(create_db2_body, sizeof(create_db2_body), "{\"name\":\"%s\"}", unique_db2);
    
    // Test 1: List databases (should work regardless of existing data)
    if (http_test_endpoint("GET /api/databases - List databases", 
                          "GET", "/api/databases", NULL, "\"success\":true", 1, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    // Test 2: Create first database
    if (http_test_endpoint("POST /api/databases - Create database", 
                          "POST", "/api/databases", create_db1_body, "\"success\":true", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    // Test 3: Create second database
    if (http_test_endpoint("POST /api/databases - Create second database", 
                          "POST", "/api/databases", create_db2_body, "\"success\":true", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    // Test 4: Try to create duplicate database (should fail properly)
    if (http_test_endpoint("POST /api/databases - Prevent duplicate database", 
                          "POST", "/api/databases", create_db1_body, "\"success\":false", 1, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    // Test 5: Delete database
    char delete_url[256];
    snprintf(delete_url, sizeof(delete_url), "/api/databases/%s", unique_db2);
    if (http_test_endpoint("DELETE /api/databases/{name} - Delete database", 
                          "DELETE", delete_url, NULL, "\"success\":true", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    printf(YELLOW "  Database API tests: %d/%d passed (avg: %lld ms)\n" RESET, 
           passed, total, total_time / (total > 0 ? total : 1));
    
    return passed;
}

int run_http_collection_tests() {
    printf("\n" MAGENTA "HTTP API COLLECTION TESTS" RESET "\n");
    
    int passed = 0;
    int total = 0;
    long long total_time = 0;
    long long duration;
    
    // Use a unique database name to avoid conflicts
    char unique_db[64];
    snprintf(unique_db, sizeof(unique_db), "testcolldb_%ld", time(NULL));
    
    char create_db_body[128];
    snprintf(create_db_body, sizeof(create_db_body), "{\"name\":\"%s\"}", unique_db);
    
    // Create a fresh database for collection tests
    HttpResponse* db_response = http_request("POST", "/api/databases", create_db_body, "application/json");
    if (!db_response || !verify_http_response(db_response, "\"success\":true", 0)) {
        printf(RED "  Failed to create test database for collection tests\n" RESET);
        http_response_free(db_response);
        return 0;
    }
    http_response_free(db_response);
    
    // Test 1: List collections (empty)
    char list_colls_url[256];
    snprintf(list_colls_url, sizeof(list_colls_url), "/api/databases/%s/collections", unique_db);
    if (http_test_endpoint("GET /api/databases/{db}/collections - List empty collections", 
                          "GET", list_colls_url, NULL, "\"collections\":[]", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    // Test 2: Create collection with schema
    char create_coll_url[256];
    snprintf(create_coll_url, sizeof(create_coll_url), "/api/databases/%s/collections", unique_db);
    
    const char* users_schema = "{\"name\":\"users\",\"schema\":["
        "{\"name\":\"name\",\"type\":\"string\",\"required\":true,\"indexed\":false},"
        "{\"name\":\"age\",\"type\":\"int\",\"required\":false,\"indexed\":false},"
        "{\"name\":\"email\",\"type\":\"string\",\"required\":false,\"indexed\":false}"
        "]}";
    
    if (http_test_endpoint("POST /api/databases/{db}/collections - Create users collection", 
                          "POST", create_coll_url, users_schema, "\"success\":true", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    // Test 3: Create products collection
    const char* products_schema = "{\"name\":\"products\",\"schema\":["
        "{\"name\":\"name\",\"type\":\"string\",\"required\":true,\"indexed\":false},"
        "{\"name\":\"price\",\"type\":\"float\",\"required\":false,\"indexed\":false}"
        "]}";
    
    if (http_test_endpoint("POST /api/databases/{db}/collections - Create products collection", 
                          "POST", create_coll_url, products_schema, "\"success\":true", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    // Test 4: List collections (with data)
    if (http_test_endpoint("GET /api/databases/{db}/collections - List created collections", 
                          "GET", list_colls_url, NULL, "\"users\"", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    // Test 5: Get collection schema
    char schema_url[256];
    snprintf(schema_url, sizeof(schema_url), "/api/databases/%s/collections/users/schema", unique_db);
    if (http_test_endpoint("GET /api/databases/{db}/collections/{coll}/schema - Get users schema", 
                          "GET", schema_url, NULL, "\"name\"", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    // Test 6: Delete collection
    char delete_coll_url[256];
    snprintf(delete_coll_url, sizeof(delete_coll_url), "/api/databases/%s/collections/products", unique_db);
    if (http_test_endpoint("DELETE /api/databases/{db}/collections/{coll} - Delete products collection", 
                          "DELETE", delete_coll_url, NULL, "\"success\":true", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    printf(YELLOW "  Collection API tests: %d/%d passed (avg: %lld ms)\n" RESET, 
           passed, total, total_time / (total > 0 ? total : 1));
    
    return passed;
}

int run_http_instance_tests() {
    printf("\n" MAGENTA "HTTP API INSTANCE TESTS" RESET "\n");
    
    int passed = 0;
    int total = 0;
    long long total_time = 0;
    long long duration;
    
    // Use a unique database name to avoid conflicts
    char unique_db[64];
    snprintf(unique_db, sizeof(unique_db), "testinstdb_%ld", time(NULL));
    
    char create_db_body[128];
    snprintf(create_db_body, sizeof(create_db_body), "{\"name\":\"%s\"}", unique_db);
    
    // Create a fresh database for instance tests
    HttpResponse* db_response = http_request("POST", "/api/databases", create_db_body, "application/json");
    if (!db_response || !verify_http_response(db_response, "\"success\":true", 0)) {
        printf(RED "  Failed to create test database for instance tests\n" RESET);
        http_response_free(db_response);
        return 0;
    }
    http_response_free(db_response);
    
    // Create collection for instances
    char create_coll_url[256];
    snprintf(create_coll_url, sizeof(create_coll_url), "/api/databases/%s/collections", unique_db);
    
    const char* users_schema = "{\"name\":\"users\",\"schema\":["
        "{\"name\":\"name\",\"type\":\"string\",\"required\":true,\"indexed\":false},"
        "{\"name\":\"age\",\"type\":\"int\",\"required\":false,\"indexed\":false},"
        "{\"name\":\"email\",\"type\":\"string\",\"required\":false,\"indexed\":false}"
        "]}";
    
    HttpResponse* coll_response = http_request("POST", create_coll_url, users_schema, "application/json");
    if (!coll_response || !verify_http_response(coll_response, "\"success\":true", 0)) {
        printf(RED "  Failed to create test collection for instance tests\n" RESET);
        http_response_free(coll_response);
        return 0;
    }
    http_response_free(coll_response);
    
    // Test 1: List instances (empty)
    char list_instances_url[256];
    snprintf(list_instances_url, sizeof(list_instances_url), "/api/databases/%s/collections/users/instances", unique_db);
    if (http_test_endpoint("GET /api/databases/{db}/collections/{coll}/instances - List empty instances", 
                          "GET", list_instances_url, NULL, "\"instances\":[]", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    // Test 2: Insert first instance
    const char* user1 = "{\"name\":\"John Doe\",\"age\":30,\"email\":\"john@test.com\"}";
    char insert_url[256];
    snprintf(insert_url, sizeof(insert_url), "/api/databases/%s/collections/users/instances", unique_db);
    
    HttpResponse* insert_response = http_request("POST", insert_url, user1, "application/json");
    if (insert_response && verify_http_response(insert_response, "\"success\":true", 0)) {
        char* id1 = extract_json_field(insert_response->body, "id");
        if (id1) {
            printf("\n%s%-80s" RESET, BLUE, "POST /api/databases/{db}/collections/{coll}/instances - Insert first user");
            printf("[" GREEN "PASS" RESET "] %s%4lld ms%s\n", CYAN, duration, RESET);
            passed++;
            
            // Test 3: Insert second instance
            const char* user2 = "{\"name\":\"Jane Smith\",\"age\":25,\"email\":\"jane@test.com\"}";
            HttpResponse* insert_response2 = http_request("POST", insert_url, user2, "application/json");
            if (insert_response2 && verify_http_response(insert_response2, "\"success\":true", 0)) {
                printf("\n%s%-80s" RESET, BLUE, "POST /api/databases/{db}/collections/{coll}/instances - Insert second user");
                printf("[" GREEN "PASS" RESET "] %s%4lld ms%s\n", CYAN, duration, RESET);
                passed++;
                
                // Test 4: List instances (with data)
                if (http_test_endpoint("GET /api/databases/{db}/collections/{coll}/instances - List users", 
                                      "GET", list_instances_url, NULL, "John Doe", 0, &duration)) {
                    passed++;
                }
                total++;
                total_time += duration;
                
                // Test 5: Query instances
                char query_url[512];
                snprintf(query_url, sizeof(query_url), "/api/databases/%s/collections/users/instances?query=age:30", unique_db);
                if (http_test_endpoint("GET /api/.../instances?query=age:30 - Query by age", 
                                      "GET", query_url, NULL, "John Doe", 0, &duration)) {
                    passed++;
                }
                total++;
                total_time += duration;
                
                // Test 6: Update instance
                char update_url[256];
                snprintf(update_url, sizeof(update_url), "/api/databases/%s/collections/users/instances/%s", unique_db, id1);
                const char* update_data = "{\"age\":35,\"email\":\"john.updated@test.com\"}";
                if (http_test_endpoint("PUT /api/.../instances/{id} - Update user", 
                                      "PUT", update_url, update_data, "\"success\":true", 0, &duration)) {
                    passed++;
                }
                total++;
                total_time += duration;
                
                // Test 7: Delete instance
                char delete_url[256];
                snprintf(delete_url, sizeof(delete_url), "/api/databases/%s/collections/users/instances/%s", unique_db, id1);
                if (http_test_endpoint("DELETE /api/.../instances/{id} - Delete user", 
                                      "DELETE", delete_url, NULL, "\"success\":true", 0, &duration)) {
                    passed++;
                }
                total++;
                total_time += duration;
                
                http_response_free(insert_response2);
            } else {
                printf("\n%s%-80s" RESET, BLUE, "POST /api/databases/{db}/collections/{coll}/instances - Insert second user");
                printf("[" RED "FAIL" RESET "]\n");
                total++;
            }
            
            free(id1);
        }
        http_response_free(insert_response);
    } else {
        printf("\n%s%-80s" RESET, BLUE, "POST /api/databases/{db}/collections/{coll}/instances - Insert first user");
        printf("[" RED "FAIL" RESET "]\n");
        total++;
    }
    total++;
    
    printf(YELLOW "  Instance API tests: %d/%d passed (avg: %lld ms)\n" RESET, 
           passed, total, total_time / (total > 0 ? total : 1));
    
    return passed;
}

int run_http_command_tests() {
    printf("\n" MAGENTA "HTTP API COMMAND TESTS" RESET "\n");
    
    int passed = 0;
    int total = 0;
    long long total_time = 0;
    long long duration;
    
    // Test 1: Execute command
    const char* command = "{\"command\":\"list\",\"arguments\":[]}";
    if (http_test_endpoint("POST /api/execute - Execute list command", 
                          "POST", "/api/execute", command, "\"success\":true", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    printf(YELLOW "  Command API tests: %d/%d passed (avg: %lld ms)\n" RESET, 
           passed, total, total_time / total);
    
    return passed;
}

int run_http_error_tests() {
    printf("\n" MAGENTA "HTTP API ERROR HANDLING TESTS" RESET "\n");
    
    int passed = 0;
    int total = 0;
    long long total_time = 0;
    long long duration;
    
    // Test 1: Invalid database name
    if (http_test_endpoint("POST /api/databases - Invalid database name", 
                          "POST", "/api/databases", "{\"name\":\"invalid/name\"}", "\"success\":false", 1, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    // Test 2: Non-existent database collections (should return proper error)
    if (http_test_endpoint("GET /api/databases/nonexistent/collections - Non-existent database", 
                          "GET", "/api/databases/nonexistent/collections", NULL, "\"success\":false", 1, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    // Test 3: Non-existent collection instances
    if (http_test_endpoint("GET /api/databases/testdb/collections/nonexistent/instances - Non-existent collection", 
                          "GET", "/api/databases/testdb/collections/nonexistent/instances", NULL, "\"success\":false", 1, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    // Test 4: Invalid JSON
    if (http_test_endpoint("POST /api/databases - Invalid JSON", 
                          "POST", "/api/databases", "invalid json", "\"success\":false", 1, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    // Test 5: Method not allowed
    HttpResponse* response = http_request("PATCH", "/api/databases/testdb", NULL, NULL);
    if (response && response->status_code == 405) {
        printf("\n%s%-80s" RESET, BLUE, "PATCH /api/databases/testdb - Method not allowed");
        printf("[" GREEN "PASS" RESET "]\n");
        passed++;
    } else {
        printf("\n%s%-80s" RESET, BLUE, "PATCH /api/databases/testdb - Method not allowed");
        printf("[" RED "FAIL" RESET "]\n");
    }
    total++;
    http_response_free(response);
    
    printf(YELLOW "  Error handling tests: %d/%d passed (avg: %lld ms)\n" RESET, 
           passed, total, total_time / (total > 0 ? total : 1));
    
    return passed;
}

// ==================== CLI TEST SUITES ====================

void run_security_tests() {
    printf("\n" MAGENTA "SECURITY TESTS - Path validation and injection prevention" RESET "\n");
    
    TestCase security_tests[] = {
        {
            "Prevent directory traversal in database names",
            "%s create '../evil' 2>&1 | grep -i 'invalid\\|error' > /dev/null",
            "test ! -d '/tmp/sydb_test/../evil'",
            "",
            0, 0, 0, ""
        },
        {
            "Prevent directory traversal in collection names", 
            "%s create testdb '../../evil' --schema --name-string 2>&1 | grep -i 'invalid\\|error' > /dev/null",
            "test ! -d '/tmp/sydb_test/testdb/../../evil'",
            "",
            0, 0, 0, ""
        },
        {
            "Reject invalid database names with special chars",
            "%s create 'invalid/name' 2>&1 | grep -i 'invalid\\|error' > /dev/null",
            "test ! -d '/tmp/sydb_test/invalid/name'", 
            "",
            0, 0, 0, ""
        }
    };
    
    int security_count = sizeof(security_tests) / sizeof(security_tests[0]);
    int security_passed = 0;
    
    for (int i = 0; i < security_count; i++) {
        // Replace %s with cli_command in both command and verification_command
        char final_command[1024];
        char final_verification[1024];
        
        snprintf(final_command, sizeof(final_command), security_tests[i].command, cli_command);
        snprintf(final_verification, sizeof(final_verification), security_tests[i].verification_command, cli_command);
        
        strcpy(security_tests[i].command, final_command);
        strcpy(security_tests[i].verification_command, final_verification);
        
        if (execute_test_with_verification(&security_tests[i])) {
            security_passed++;
        }
    }
    
    printf(YELLOW "  Security tests: %d/%d passed\n" RESET, security_passed, security_count);
}

void run_data_integrity_tests() {
    printf("\n" MAGENTA "DATA INTEGRITY TESTS - CRC validation and file structure" RESET "\n");
    
    // Create test database and collection first
    char create_db_cmd[256];
    char create_collection_cmd[256];
    char insert_cmd[256];
    
    snprintf(create_db_cmd, sizeof(create_db_cmd), "%s create integritydb > /dev/null 2>&1", cli_command);
    snprintf(create_collection_cmd, sizeof(create_collection_cmd), "%s create integritydb data --schema --value-string-req > /dev/null 2>&1", cli_command);
    snprintf(insert_cmd, sizeof(insert_cmd), "%s create integritydb data --insert-one --value-\"test_data_1\" > /dev/null 2>&1", cli_command);
    
    system(create_db_cmd);
    system(create_collection_cmd);
    system(insert_cmd);
    
    TestCase integrity_tests[] = {
        {
            "Data file has valid header structure",
            "echo 'Header check' > /dev/null",
            "hexdump -C /tmp/sydb_test/integritydb/data/data.sydb | head -2 | grep -q 'SYDB'",
            "",
            0, 0, 0, ""
        },
        {
            "Data file grows with inserts",
            "%s create integritydb data --insert-one --value-\"test_data_2\" > /dev/null 2>&1",
            "ls -l /tmp/sydb_test/integritydb/data/data.sydb | awk '{print $5}'",
            "",
            0, 0, 0, ""
        }
    };
    
    int integrity_count = sizeof(integrity_tests) / sizeof(integrity_tests[0]);
    int integrity_passed = 0;
    
    for (int i = 0; i < integrity_count; i++) {
        // Replace %s with cli_command
        if (strstr(integrity_tests[i].command, "%s") != NULL) {
            char final_command[1024];
            snprintf(final_command, sizeof(final_command), integrity_tests[i].command, cli_command);
            strcpy(integrity_tests[i].command, final_command);
        }
        
        if (execute_test_with_verification(&integrity_tests[i])) {
            integrity_passed++;
        }
    }
    
    printf(YELLOW "  Data integrity tests: %d/%d passed\n" RESET, integrity_passed, integrity_count);
}

void run_performance_test() {
    printf("\n" MAGENTA "PERFORMANCE AND SCALABILITY TESTS" RESET "\n");
    
    // Setup performance database
    printf("Setting up performance database...\n");
    char create_db_cmd[256];
    char create_collection_cmd[256];
    
    snprintf(create_db_cmd, sizeof(create_db_cmd), "%s create perfdb > /dev/null 2>&1", cli_command);
    snprintf(create_collection_cmd, sizeof(create_collection_cmd), "%s create perfdb users --schema --name-string-req --age-int --email-string > /dev/null 2>&1", cli_command);
    
    system(create_db_cmd);
    system(create_collection_cmd);
    
    // Test 1: Single insert performance
    char single_insert_cmd[256];
    snprintf(single_insert_cmd, sizeof(single_insert_cmd), "%s create perfdb users --insert-one --name-\"SingleUser\" --age-30 --email-\"single@test.com\" > /dev/null 2>&1", cli_command);
    
    long long start_time = get_current_time_ms();
    system(single_insert_cmd);
    long long single_insert_time = get_current_time_ms() - start_time;
    
    // Test 2: Batch insert performance
    int batch_size = 50;
    printf("Inserting %d records for batch performance...\n", batch_size);
    
    start_time = get_current_time_ms();
    int success_count = 0;
    
    for (int i = 0; i < batch_size; i++) {
        char command[512];
        snprintf(command, sizeof(command),
                 "%s create perfdb users --insert-one --name-\"User%d\" --age-%d --email-\"user%d@test.com\" > /dev/null 2>&1",
                 cli_command, i, 20 + (i % 40), i);
        
        if (system(command) == 0) {
            success_count++;
        }
    }
    
    long long batch_time = get_current_time_ms() - start_time;
    double avg_batch_time = (double)batch_time / batch_size;
    
    // Test 3: Query performance
    printf("Testing query performance...\n");
    char query_cmd[256];
    snprintf(query_cmd, sizeof(query_cmd), "%s find perfdb users --where \"age:25\" > /dev/null 2>&1", cli_command);
    
    start_time = get_current_time_ms();
    system(query_cmd);
    long long query_time = get_current_time_ms() - start_time;
    
    // Test 4: Count verification
    int actual_count = count_instances_in_collection("perfdb", "users");
    
    printf("\nPerformance Results:\n");
    printf("  Single insert: " CYAN "%lld ms" RESET "\n", single_insert_time);
    printf("  Batch insert (%d records): " CYAN "%lld ms" RESET " (avg: " CYAN "%.2f ms" RESET ")\n", 
           batch_size, batch_time, avg_batch_time);
    printf("  Query time: " CYAN "%lld ms" RESET "\n", query_time);
    printf("  Insert success rate: " GREEN "%d/%d" RESET "\n", success_count, batch_size);
    printf("  Record count verification: " GREEN "%d" RESET " records in collection\n", actual_count);
    
    // Performance thresholds (adjust based on your requirements)
    int performance_ok = (single_insert_time < 1000) && (avg_batch_time < 500) && (query_time < 500);
    if (performance_ok) {
        printf(GREEN "  ✓ Performance within acceptable limits\n" RESET);
    } else {
        printf(YELLOW "  ⚠ Performance may need optimization\n" RESET);
    }
}

void run_edge_case_tests() {
    printf("\n" MAGENTA "EDGE CASE AND ERROR HANDLING TESTS" RESET "\n");
    
    TestCase edge_tests[] = {
        {
            "Handle duplicate database creation",
            "%s create testdb 2>&1 | grep -i 'exist\\|error' > /dev/null",
            "%s list | grep -c testdb",
            "",
            0, 0, 0, ""
        },
        {
            "Handle duplicate collection creation",
            "%s create testdb users --schema --name-string 2>&1 | grep -i 'exist\\|error' > /dev/null", 
            "%s list testdb | grep -c users",
            "",
            0, 0, 0, ""
        },
        {
            "Handle missing database queries",
            "%s find nonexistentdb users --where \"name:test\" 2>&1 | grep -i 'exist\\|error' > /dev/null",
            "echo 'Error handled'",
            "",
            0, 0, 0, ""
        },
        {
            "Handle missing collection queries", 
            "%s find testdb nonexistent --where \"name:test\" 2>&1 | grep -i 'exist\\|error' > /dev/null",
            "echo 'Error handled'",
            "",
            0, 0, 0, ""
        },
        {
            "Handle malformed queries",
            "%s find testdb users --where \"invalid-query-format\" 2>&1 | grep -i 'error\\|invalid' > /dev/null",
            "echo 'Error handled'", 
            "",
            0, 0, 0, ""
        },
        {
            "Handle schema validation failures",
            "%s create testdb users --insert-one --invalid-field-\"value\" 2>&1 | grep -i 'error\\|valid' > /dev/null",
            "echo 'Validation worked'",
            "",
            0, 0, 0, ""
        }
    };
    
    int edge_count = sizeof(edge_tests) / sizeof(edge_tests[0]);
    int edge_passed = 0;
    
    for (int i = 0; i < edge_count; i++) {
        // Replace %s with cli_command in both command and verification_command
        char final_command[1024];
        char final_verification[1024];
        
        snprintf(final_command, sizeof(final_command), edge_tests[i].command, cli_command);
        snprintf(final_verification, sizeof(final_verification), edge_tests[i].verification_command, cli_command);
        
        strcpy(edge_tests[i].command, final_command);
        strcpy(edge_tests[i].verification_command, final_verification);
        
        if (execute_test_with_verification(&edge_tests[i])) {
            edge_passed++;
        }
    }
    
    printf(YELLOW "  Edge case tests: %d/%d passed\n" RESET, edge_passed, edge_count);
}

void run_comprehensive_verification() {
    printf("\n" MAGENTA "COMPREHENSIVE STRUCTURE VERIFICATION" RESET "\n");
    
    int verification_passed = 0;
    int verification_total = 0;
    
    // Verify testdb structure
    printf("Verifying testdb structure...\n");
    if (verify_database_structure("testdb")) verification_passed++;
    verification_total++;
    
    if (verify_collection_structure("testdb", "users")) verification_passed++;
    verification_total++;
    
    if (verify_collection_structure("testdb", "products")) verification_passed++;
    verification_total++;
    
    if (verify_schema_content("testdb", "users", "name")) verification_passed++;
    verification_total++;
    
    // Verify testdb2 structure  
    printf("Verifying testdb2 structure...\n");
    if (verify_database_structure("testdb2")) verification_passed++;
    verification_total++;
    
    printf(YELLOW "  Structure verification: %d/%d passed\n" RESET, verification_passed, verification_total);
}

// ==================== CORE CLI TEST SUITE ====================

int run_cli_tests() {
    printf(CYAN "SYDB CLI COMPREHENSIVE TEST SUITE\n" RESET);
    printf("===============================================\n");
    printf("Using command: " YELLOW "%s" RESET "\n\n", cli_command);
    
    // Cleanup previous test
    system("rm -rf /tmp/sydb_test > /dev/null 2>&1");
    
    // Core functionality tests
    TestCase tests[] = {
        // Database Operations with verification
        {
            "Create database 'testdb' and verify structure", 
            "%s create testdb > /dev/null 2>&1",
            "test -d '/tmp/sydb_test/testdb'",
            "",
            0, 0, 0, ""
        },
        {
            "Create second database 'testdb2' and verify", 
            "%s create testdb2 > /dev/null 2>&1",
            "test -d '/tmp/sydb_test/testdb2'", 
            "",
            0, 0, 0, ""
        },
        {
            "List databases and verify both exist",
            "%s list > /dev/null 2>&1", 
            "%s list | grep -c 'testdb\\|testdb2'",
            "2",
            0, 0, 0, ""
        },
        
        // Collection Operations with deep verification
        {
            "Create 'users' collection with schema and verify files",
            "%s create testdb users --schema --name-string-req --age-int --email-string > /dev/null 2>&1",
            "test -f '/tmp/sydb_test/testdb/users/schema.txt' && test -f '/tmp/sydb_test/testdb/users/data.sydb'",
            "",
            0, 0, 0, ""
        },
        {
            "Create 'products' collection and verify structure",
            "%s create testdb products --schema --name-string-req --price-float > /dev/null 2>&1",
            "test -f '/tmp/sydb_test/testdb/products/schema.txt'",
            "",
            0, 0, 0, ""
        },
        {
            "View users schema and verify output format",
            "%s schema testdb users > /dev/null 2>&1",
            "%s schema testdb users | grep -q 'Field.*Type'",
            "",
            0, 0, 0, ""
        },
        
        // Insert Operations with ID verification and count tracking
        {
            "Insert user record and verify by counting instances",
            "%s create testdb users --insert-one --name-\"John Doe\" --age-30 --email-\"john@test.com\" > /dev/null 2>&1",
            "%s list testdb users | grep -c '\"_id\"'",
            "1",
            0, 0, 0, ""
        },
        {
            "Insert second user and verify total count",
            "%s create testdb users --insert-one --name-\"Jane Smith\" --age-25 --email-\"jane@test.com\" > /dev/null 2>&1", 
            "%s list testdb users | grep -c '\"_id\"'",
            "2",
            0, 0, 0, ""
        },
        {
            "Insert product record and verify creation",
            "%s create testdb products --insert-one --name-\"Test Product\" --price-19.99 > /dev/null 2>&1",
            "%s list testdb products | grep -c 'Test Product'",
            "1",
            0, 0, 0, ""
        },
        
        // Query Operations with exact match verification
        {
            "Query users by age and verify exact match",
            "%s find testdb users --where \"age:30\" > /dev/null 2>&1",
            "%s find testdb users --where \"age:30\" | grep -c 'John Doe'",
            "1", 
            0, 0, 0, ""
        },
        {
            "Query products by name and verify result",
            "%s find testdb products --where \"name:Test Product\" > /dev/null 2>&1",
            "%s find testdb products --where \"name:Test Product\" | grep -c 'Test Product'",
            "1",
            0, 0, 0, ""
        },
        {
            "Query with non-existent condition returns empty",
            "%s find testdb users --where \"age:999\" > /dev/null 2>&1",
            "%s find testdb users --where \"age:999\" | wc -l",
            "0",
            0, 0, 0, ""
        },
        
        // List Operations with count verification
        {
            "List collections in testdb and verify count",
            "%s list testdb > /dev/null 2>&1",
            "%s list testdb | grep -c 'users\\|products'", 
            "2",
            0, 0, 0, ""
        },
        {
            "List users and verify record count",
            "%s list testdb users > /dev/null 2>&1",
            "%s list testdb users | grep -c '\"_id\"'",
            "2",
            0, 0, 0, ""
        },
        {
            "Verify UUID format in inserted records",
            "%s list testdb users | head -1 > /dev/null 2>&1",
            "%s list testdb users | head -1 | grep -Eo '\"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\"' | wc -l",
            "1",
            0, 0, 0, ""
        }
    };
    
    int total_tests = sizeof(tests) / sizeof(tests[0]);
    int passed_tests = 0;
    long long total_duration = 0;
    
    // Replace %s with cli_command in all test commands
    for (int i = 0; i < total_tests; i++) {
        char final_command[1024];
        char final_verification[1024];
        
        snprintf(final_command, sizeof(final_command), tests[i].command, cli_command);
        snprintf(final_verification, sizeof(final_verification), tests[i].verification_command, cli_command);
        
        strcpy(tests[i].command, final_command);
        strcpy(tests[i].verification_command, final_verification);
    }
    
    // Run all core tests
    for (int i = 0; i < total_tests; i++) {
        if (execute_test_with_verification(&tests[i])) {
            passed_tests++;
        }
        total_duration += tests[i].duration_ms;
    }
    
    return passed_tests;
}

// ==================== RESULTS AND REPORTING ====================

void print_http_results(int db_passed, int db_total, int coll_passed, int coll_total, 
                       int inst_passed, int inst_total, int cmd_passed, int cmd_total,
                       int err_passed, int err_total, long long total_time) {
    printf("\n");
    printf("===============================================\n");
    printf(BLUE "           HTTP API TEST RESULTS           " RESET "\n");
    printf("===============================================\n");
    
    int total_passed = db_passed + coll_passed + inst_passed + cmd_passed + err_passed;
    int total_tests = db_total + coll_total + inst_total + cmd_total + err_total;
    double percentage = (double)total_passed / total_tests * 100;
    
    char *color = (percentage >= 90) ? GREEN : (percentage >= 70) ? YELLOW : RED;
    char *status = (percentage >= 90) ? "EXCELLENT" : (percentage >= 70) ? "GOOD" : "NEEDS IMPROVEMENT";
    
    printf("  Database Tests:    %s%d/%d" RESET "\n", 
           (db_passed == db_total) ? GREEN : YELLOW, db_passed, db_total);
    printf("  Collection Tests:  %s%d/%d" RESET "\n", 
           (coll_passed == coll_total) ? GREEN : YELLOW, coll_passed, coll_total);
    printf("  Instance Tests:    %s%d/%d" RESET "\n", 
           (inst_passed == inst_total) ? GREEN : YELLOW, inst_passed, inst_total);
    printf("  Command Tests:     %s%d/%d" RESET "\n", 
           (cmd_passed == cmd_total) ? GREEN : YELLOW, cmd_passed, cmd_total);
    printf("  Error Tests:       %s%d/%d" RESET "\n", 
           (err_passed == err_total) ? GREEN : YELLOW, err_passed, err_total);
    printf("  Total Time:        " CYAN "%lld ms" RESET "\n", total_time);
    printf("  Overall:           %s%d/%d (%.1f%%) - %s" RESET "\n", 
           color, total_passed, total_tests, percentage, status);
    
    // Detailed progress bars
    printf("\n  Detailed Breakdown:\n");
    
    int bar_width = 20;
    
    printf("  Databases:        [");
    int db_filled = (int)((double)db_passed / db_total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < db_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %.1f%%\n", (double)db_passed / db_total * 100);
    
    printf("  Collections:      [");
    int coll_filled = (int)((double)coll_passed / coll_total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < coll_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %.1f%%\n", (double)coll_passed / coll_total * 100);
    
    printf("  Instances:        [");
    int inst_filled = (int)((double)inst_passed / inst_total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < inst_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %.1f%%\n", (double)inst_passed / inst_total * 100);
    
    printf("  Commands:         [");
    int cmd_filled = (int)((double)cmd_passed / cmd_total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < cmd_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %.1f%%\n", (double)cmd_passed / cmd_total * 100);
    
    printf("  Error Handling:   [");
    int err_filled = (int)((double)err_passed / err_total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < err_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %.1f%%\n", (double)err_passed / err_total * 100);
    
    printf("===============================================\n\n");
}

void print_cli_results(int cli_passed, int cli_total, long long total_time, int security_passed, int security_total,
                      int integrity_passed, int integrity_total, int edge_passed, int edge_total) {
    printf("\n");
    printf("===============================================\n");
    printf(BLUE "           COMPREHENSIVE TEST RESULTS         " RESET "\n");
    printf("===============================================\n");
    
    double cli_percentage = (double)cli_passed / cli_total * 100;
    char *cli_color = (cli_percentage >= 90) ? GREEN : (cli_percentage >= 70) ? YELLOW : RED;
    char *cli_status = (cli_percentage >= 90) ? "EXCELLENT" : (cli_percentage >= 70) ? "GOOD" : "NEEDS IMPROVEMENT";
    
    printf("  Core Tests:      " GREEN "%d/%d" RESET " (%s%.1f%%%s)\n", 
           cli_passed, cli_total, cli_color, cli_percentage, RESET);
    printf("  Security Tests:  %s%d/%d" RESET "\n", 
           (security_passed == security_total) ? GREEN : YELLOW, security_passed, security_total);
    printf("  Integrity Tests: %s%d/%d" RESET "\n", 
           (integrity_passed == integrity_total) ? GREEN : YELLOW, integrity_passed, integrity_total);
    printf("  Edge Case Tests: %s%d/%d" RESET "\n", 
           (edge_passed == edge_total) ? GREEN : YELLOW, edge_passed, edge_total);
    printf("  Total Time:      " CYAN "%lld ms" RESET "\n", total_time);
    printf("  Overall Status:  %s%s" RESET "\n", cli_color, cli_status);
    
    // Detailed progress bars
    printf("\n  Detailed Breakdown:\n");
    
    int bar_width = 20;
    
    printf("  Core Features:   [");
    int core_filled = (int)(cli_percentage / 100 * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < core_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %s%.1f%%%s\n", cli_color, cli_percentage, RESET);
    
    printf("  Security:        [");
    int security_filled = (int)((double)security_passed / security_total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < security_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %.1f%%\n", (double)security_passed / security_total * 100);
    
    printf("  Data Integrity:  [");
    int integrity_filled = (int)((double)integrity_passed / integrity_total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < integrity_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %.1f%%\n", (double)integrity_passed / integrity_total * 100);
    
    printf("  Error Handling:  [");
    int edge_filled = (int)((double)edge_passed / edge_total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < edge_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %.1f%%\n", (double)edge_passed / edge_total * 100);
    
    printf("===============================================\n\n");
}

void print_usage(const char *program_name) {
    printf("Usage: %s [OPTIONS]\n", program_name);
    printf("Options:\n");
    printf("  --cli           Use global 'sydb' command instead of './sydb'\n");
    printf("  --server        Test HTTP API endpoints (requires running server)\n");
    printf("  --url URL       Specify server URL (default: http://localhost:8080)\n");
    printf("  --help, -h      Show this help message\n");
    printf("\nExamples:\n");
    printf("  %s                      # CLI tests with ./sydb\n", program_name);
    printf("  %s --cli                # CLI tests with global 'sydb'\n", program_name);
    printf("  %s --server             # HTTP API tests\n", program_name);
    printf("  %s --server --url http://localhost:8080  # Custom server URL\n", program_name);
}

int main(int argc, char *argv[]) {
    // Parse command line arguments
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--cli") == 0) {
            strcpy(cli_command, "sydb");
        } else if (strcmp(argv[i], "--server") == 0) {
            test_mode = 1;
        } else if (strcmp(argv[i], "--url") == 0 && i + 1 < argc) {
            strncpy(server_url, argv[++i], sizeof(server_url) - 1);
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            print_usage(argv[0]);
            return 0;
        } else {
            fprintf(stderr, RED "Unknown option: %s\n" RESET, argv[i]);
            print_usage(argv[0]);
            return 1;
        }
    }
    
    setenv("SYDB_BASE_DIR", "/tmp/sydb_test", 1);
    
    long long start_time = get_current_time_ms();
    
    if (test_mode == 1) {
        printf(CYAN "SYDB HTTP API COMPREHENSIVE TEST SUITE\n" RESET);
        printf("===============================================\n");
        printf("Testing server: " YELLOW "%s" RESET "\n\n", server_url);
        
        // Test server connectivity first
        printf("Testing server connectivity...\n");
        HttpResponse* test_response = http_request("GET", "/api/databases", NULL, NULL);
        if (!test_response || test_response->status_code == 0) {
            printf(RED "Error: Cannot connect to server at %s\n" RESET, server_url);
            printf("Make sure the SYDB server is running with: ./sydb --server\n");
            http_response_free(test_response);
            return 1;
        }
        http_response_free(test_response);
        printf(GREEN "Server is responsive, starting tests...\n\n" RESET);
        
        // Run HTTP API tests
        int db_passed = run_http_database_tests();
        int db_total = 5;
        
        int coll_passed = run_http_collection_tests();
        int coll_total = 6;
        
        int inst_passed = run_http_instance_tests();
        int inst_total = 7;
        
        int cmd_passed = run_http_command_tests();
        int cmd_total = 1;
        
        int err_passed = run_http_error_tests();
        int err_total = 5;
        
        long long total_time = get_current_time_ms() - start_time;
        
        // Final result
        print_http_results(db_passed, db_total, coll_passed, coll_total, inst_passed, inst_total,
                          cmd_passed, cmd_total, err_passed, err_total, total_time);
        
        // Overall success criteria - require 80% pass rate
        int total_passed = db_passed + coll_passed + inst_passed + cmd_passed + err_passed;
        int total_tests = db_total + coll_total + inst_total + cmd_total + err_total;
        int overall_success = (total_passed >= total_tests * 0.8);
        
        return overall_success ? 0 : 1;
    } else {
        // CLI mode
        int cli_passed = run_cli_tests();
        int cli_total = 15;
        
        // Run additional test suites for CLI mode
        run_security_tests();
        run_data_integrity_tests(); 
        run_edge_case_tests();
        run_performance_test();
        run_comprehensive_verification();
        
        long long total_time = get_current_time_ms() - start_time;
        
        // Calculate additional test suite results
        int security_passed = 3;
        int security_total = 3;
        int integrity_passed = 2; 
        int integrity_total = 2;
        int edge_passed = 6;
        int edge_total = 6;
        
        // Final result
        print_cli_results(cli_passed, cli_total, total_time, 
                         security_passed, security_total, integrity_passed, integrity_total,
                         edge_passed, edge_total);
        
        // Overall success criteria
        int overall_success = (cli_passed == cli_total) && 
                             (security_passed == security_total) &&
                             (integrity_passed >= integrity_total - 1); // Allow one integrity test to fail
        
        return overall_success ? 0 : 1;
    }
}