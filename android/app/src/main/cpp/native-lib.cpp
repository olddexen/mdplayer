#include <jni.h>
#include <cstdlib>
#include <cstring>

#include "node.h"

/*
 * Запуск Node.js внутри приложения: MainActivity.startNode(String[] arguments).
 * Node.js ожидает, что строки argv лежат подряд в одном буфере (так их раскладывает ОС),
 * поэтому сначала копируем все аргументы в общий буфер.
 * Функция не возвращается, пока работает сервер.
 */
extern "C" JNIEXPORT jint JNICALL
Java_com_mdplayer_app_MainActivity_startNode(JNIEnv *env, jclass, jobjectArray arguments) {
    jsize argc = env->GetArrayLength(arguments);

    size_t total = 0;
    for (jsize i = 0; i < argc; i++) {
        auto arg = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *chars = env->GetStringUTFChars(arg, nullptr);
        total += strlen(chars) + 1;
        env->ReleaseStringUTFChars(arg, chars);
        env->DeleteLocalRef(arg);
    }

    char *buffer = (char *) calloc(total, sizeof(char));
    char **argv = (char **) malloc(argc * sizeof(char *));
    char *cursor = buffer;
    for (jsize i = 0; i < argc; i++) {
        auto arg = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *chars = env->GetStringUTFChars(arg, nullptr);
        size_t len = strlen(chars);
        memcpy(cursor, chars, len);
        argv[i] = cursor;
        cursor += len + 1;
        env->ReleaseStringUTFChars(arg, chars);
        env->DeleteLocalRef(arg);
    }

    int result = node::Start(argc, argv);

    free(argv);
    free(buffer);
    return jint(result);
}
