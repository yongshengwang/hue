package com.cloudera.hue.livy.server

import com.cloudera.hue.livy.server.sessions.{Session, ThreadSession}
import org.scalatest.matchers.ShouldMatchers
import org.scalatest.{BeforeAndAfter, FunSpec}

class ThreadSessionSpec extends BaseSessionSpec with FunSpec with ShouldMatchers with BeforeAndAfter {

  def createSession() = ThreadSession.create("0", "spark")
}
