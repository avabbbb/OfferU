# backend/app/models/html_resume.py
from sqlalchemy import Column, Integer, String, Text, JSON, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from datetime import datetime
from .models import Base

class HtmlResumeTemplate(Base):
    """HTML 简历模板"""
    __tablename__ = "html_resume_templates"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, index=True)  # "modern-minimal"
    display_name = Column(String)  # "现代简约"
    category = Column(String)  # "creative" | "professional" | "technical"
    preview_image = Column(String)  # 预览图 URL
    html_template = Column(Text)  # Jinja2 模板
    css_template = Column(Text)  # CSS 样式
    design_tokens = Column(JSON)  # 设计变量 {"primaryColor": "#2563eb"}
    created_at = Column(DateTime, default=datetime.utcnow)

class HtmlResume(Base):
    """用户生成的 HTML 简历"""
    __tablename__ = "html_resumes"

    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"))
    template_id = Column(Integer, ForeignKey("html_resume_templates.id"))
    title = Column(String)  # "产品经理 - 现代简约版"
    html_content = Column(Text)  # 渲染后的 HTML
    design_overrides = Column(JSON)  # 用户自定义配色 {"primaryColor": "#ef4444"}
    job_ids = Column(JSON)  # 关联岗位 [1, 2, 3]
    created_at = Column(DateTime, default=datetime.utcnow)

    profile = relationship("Profile")
    template = relationship("HtmlResumeTemplate")
