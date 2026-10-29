cmake_minimum_required(VERSION 3.18.1)
project(mdplayer)

set(CMAKE_CXX_STANDARD 17)

# JNI-прослойка: вызывает node::Start() из Java
add_library(native-lib SHARED src/main/cpp/native-lib.cpp)

# Готовый Node.js для Android (nodejs-mobile): заголовки и libnode.so кладёт сюда workflow
include_directories(libnode/include/node)
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
        IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/libnode/bin/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)
target_link_libraries(native-lib libnode ${log-lib})
